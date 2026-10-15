import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { BrowserContext, Page, Request } from "playwright";
import type { Config } from "../config.js";
import { launchContext, browserDataDir } from "./browser.js";
import { loadSession, saveSession, parseWcauthtoken, type Session, type SessionCookie } from "./session.js";
import { parseProfile } from "../api/customer.js";
import { normalizeIdentifier, validateQuantity } from "../api/basket.js";
import { parseOrderStatus } from "../api/order.js";
import { ApiError, AuthError, RequestCancelledError, RequestTimeoutError, ResponseValidationError } from "../client/http.js";

export interface ResidentBrowserOptions { config: Config; session?: Session; launch?: typeof launchContext }
export interface ResidentRequest { url: string; method: string; headers: Record<string, string>; body?: string }
export interface ResidentResponse { status: number; headers: Record<string, string>; body: string }
type Pair = { wc: string; bearer: string };
type RendererReply = ResidentResponse | { error: "origin" | "redirect" | "size" | "cancelled" | "deadline" | "network" };
const ORIGIN = "https://www.sainsburys.co.uk";
const PROFILE = "/groceries-api/gol-services/customer/v1/customer/profile";
const BASKET = "/groceries-api/gol-services/basket/v2/basket";
const ORDER_STATUS = "/groceries-api/gol-services/order/v1/order/status";
const SLOT_LIST = "/groceries-api/gol-services/slot/v2/slots";
const READ_PATHS = new Set([PROFILE, BASKET, ORDER_STATUS,
  "/groceries-api/gol-services/slot/v1/slot/reservation",
  "/groceries-api/gol-services/product/v1/product",
  "/groceries-api/gol-services/product/v1/product/search/suggestions",
  "/groceries-api/gol-services/coupon/v1/coupon",
]);
const humanRequired = () => new AuthError(401, "The resident browser needs local login or MFA. Run sainsburys auth login; no basket write was retried.");
const check = (signal: AbortSignal) => { if (signal.aborted) throw new RequestCancelledError(); };

/** One headed, minimized browser retains the retailer's live JavaScript session. Runtime owns its profile lock. */
export class ResidentBrowser {
  private readonly config: Config;
  private readonly launch: typeof launchContext;
  private readonly expectedEmail: string;
  private readonly expectedUser?: string;
  private current?: Session;
  private pair?: Pair;
  private context?: BrowserContext;
  private page?: Page;
  private opening?: Promise<BrowserContext>;
  private openingCleanup?: Promise<void>;
  private userAgent?: string;
  private candidates: Pair[] = [];
  private wake = new Set<() => void>();
  private authenticated = false;
  private closed = false;
  private closing?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Set<AbortController>();

  constructor(opts: ResidentBrowserOptions) {
    this.config = opts.config;
    this.launch = opts.launch ?? launchContext;
    this.current = opts.session;
    this.expectedEmail = (opts.config.email || opts.session?.accountEmail || "").trim().toLowerCase();
    this.expectedUser = opts.session?.userId;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.expectedEmail) || (opts.session?.accountEmail && opts.session.accountEmail.toLowerCase() !== this.expectedEmail)) throw humanRequired();
    if (opts.config.baseUrl !== ORIGIN) throw new Error("Resident browser requires the exact retailer HTTPS origin.");
  }

  getSession(): Session | undefined { return this.authenticated ? this.current : undefined; }
  status(): { authenticated: boolean; needsLogin: boolean } { return { authenticated: this.authenticated, needsLogin: !this.authenticated }; }

  async start(opts: { interactive: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    try { await this.budget(opts.signal, opts.timeoutMs ?? 20_000, signal => this.enqueue(signal, async () => {
      await this.open(opts.interactive, signal);
      await this.window(opts.interactive);
      await this.navigate(signal);
      await this.authenticate(signal, opts.interactive, false);
    })); } catch(error) {
      if (!opts.interactive && error instanceof RequestTimeoutError) throw humanRequired();
      throw error;
    }
  }

  async login(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Session> {
    return this.budget(opts.signal, opts.timeoutMs ?? 300_000, signal => this.enqueue(signal, async () => {
      await this.open(true, signal);
      await this.window(true);
      try {
        await this.navigate(signal);
        await this.authenticate(signal, true, true);
        return this.current!;
      } finally { await this.window(false).catch(() => {}); }
    }));
  }

  async request(input: ResidentRequest, signal?: AbortSignal): Promise<ResidentResponse> {
    const normalized = validateRequest(input);
    // Three bounded phases: request, one silent recovery, one GET retry. Queue time is included.
    return this.budget(signal, 50_000, active => this.enqueue(active, async () => {
      if (!this.authenticated || !this.pair) throw humanRequired();
      const semanticRead = isRead(normalized);
      let recovered = false;
      if (!this.retailerPage()) {
        // No mutation was sent. A caller must explicitly recover authentication first.
        if (!semanticRead) throw humanRequired();
        await this.recoverRead(active);
        recovered = true;
      }
      if (normalized.method === "POST" && new URL(normalized.url).pathname === `${BASKET}/item` || normalized.method === "PUT") {
        await this.guardAmendment(normalized,active);
      }
      return this.readOrRequest(normalized, active, !recovered);
    }));
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    for (const wake of this.wake) wake();
    this.closing = (async () => {
      await this.queue.catch(() => {});
      await this.openingCleanup?.catch(() => {});
      const context = this.context ?? await this.opening?.catch(() => undefined);
      try {
        // Do not restore credentials deleted by logout, or replace a newer login epoch.
        const disk = await loadSession(this.config.sessionPath).catch(() => null);
        if (context && this.authenticated && this.current && this.pair && disk && sameOwnedSession(disk, this.current)) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          try {
            await this.verify(this.pair, controller.signal);
            const updated = { ...this.current, cookies: await captureCookies(context) };
            const latest = await loadSession(this.config.sessionPath);
            if (latest && sameOwnedSession(latest, this.current)) await saveSession(this.config.sessionPath, updated, controller.signal);
          } catch { /* The persistent browser profile still receives its normal close; no late credentials are recreated. */ }
          finally { clearTimeout(timer); }
        }
      } finally {
        this.authenticated = false;
        if (context) {
          context.off("request", this.observe);
          context.off("close", this.onClosed);
          await context.close();
        }
        this.context = undefined;
        this.page = undefined;
      }
    })();
    return this.closing;
  }

  private enqueue<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(() => { check(signal); if (this.closed) throw humanRequired(); return run(); });
    this.queue = task.catch(() => {});
    return raceAbort(task, signal);
  }

  private async budget<T>(outer: AbortSignal | undefined, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw humanRequired();
    if (!Number.isFinite(ms) || ms < 1 || ms > 300_000) throw new Error("Invalid resident browser deadline.");
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const cancel = () => controller.abort();
    outer?.addEventListener("abort", cancel, { once: true });
    if (outer?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
    try { return await raceAbort(run(controller.signal), controller.signal); }
    catch (error) {
      if (controller.signal.aborted) throw timedOut ? new RequestTimeoutError() : new RequestCancelledError();
      if (error instanceof AuthError || error instanceof ApiError || error instanceof RequestCancelledError || error instanceof RequestTimeoutError) throw error;
      throw new Error("The resident browser operation failed. Run local auth login if needed; no basket write was retried.");
    }
    finally { clearTimeout(timer); outer?.removeEventListener("abort", cancel); this.controllers.delete(controller); }
  }

  private async open(interactive: boolean, signal: AbortSignal): Promise<void> {
    check(signal);
    if (this.context) return;
    if (this.openingCleanup) { await raceAbort(this.openingCleanup,signal); this.openingCleanup=undefined; }
    if (!interactive) {
      if (!this.current) throw humanRequired();
      const profile = await lstat(browserDataDir(this.config.sessionPath, this.expectedEmail)).catch(() => null);
      if (!profile?.isDirectory() || profile.isSymbolicLink() || (profile.mode & 0o077) !== 0 ||
          (process.getuid && profile.uid !== process.getuid())) throw humanRequired();
    }
    this.opening ??= this.launch({ sessionPath: this.config.sessionPath, accountEmail: this.expectedEmail, headless: false, persist: true, minimized: true });
    const opening=this.opening;
    let context:BrowserContext;
    try { context = await raceAbort(opening,signal); }
    catch(error) {
      if(signal.aborted){
        this.opening=undefined;
        this.openingCleanup=opening.then(async late=>{await late.close();}).catch(()=>{});
      }
      throw error;
    }
    check(signal);
    this.context = context;
    context.on("request", this.observe);
    context.on("close", this.onClosed);
    this.page = context.pages()[0] ?? await context.newPage();
    this.userAgent = await raceAbort(this.page.evaluate(() => navigator.userAgent),signal);
    if (this.current) {
      const existing = await raceAbort(context.cookies(),signal);
      const cookies = this.current.cookies.filter(c => {
        const domain = c.domain.replace(/^\./, "");
        return (domain === "sainsburys.co.uk" || domain.endsWith(".sainsburys.co.uk")) &&
          (c.expires === undefined || c.expires === -1 || c.expires > Date.now() / 1000) &&
          !existing.some(p => p.name === c.name && p.domain === c.domain && p.path === c.path);
      });
      if (cookies.length) await context.addCookies(cookies.map(c => ({ ...c, expires: c.expires ?? -1 })));
    }
    check(signal);
  }

  private observe = (request: Request) => {
    if (this.closed) return;
    let url: URL;
    try { url = new URL(request.url()); } catch { return; }
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/groceries-api/")) return;
    const accept = (headers: Record<string, string>) => {
      if (this.closed) return;
      const wc = headers.wcauthtoken, auth = headers.authorization;
      if (!wc || !auth?.toLowerCase().startsWith("bearer ") || !auth.slice(7).trim()) return;
      try { if (this.expectedUser && parseWcauthtoken(wc).userId !== this.expectedUser) return; parseWcauthtoken(wc); } catch { return; }
      const candidate = { wc, bearer: auth.slice(7).trim() };
      if (this.candidates.some(p => p.wc === candidate.wc && p.bearer === candidate.bearer)) return;
      this.candidates.push(candidate);
      if (this.candidates.length > 16) this.candidates.shift();
      for (const wake of this.wake) wake();
    };
    accept(request.headers());
    if (typeof request.allHeaders === "function") void request.allHeaders().then(accept, () => {});
  };
  private onClosed = () => {
    this.authenticated = false;
    this.context?.off("request",this.observe);
    this.context?.off("close",this.onClosed);
    this.context = undefined; this.page = undefined; this.opening = undefined;
    this.pair = undefined; this.userAgent = undefined;
    for (const controller of this.controllers) controller.abort();
    for (const wake of this.wake) wake();
  };

  private async window(show: boolean): Promise<void> {
    if (!this.context || !this.page) throw humanRequired();
    let cdp;
    try {
      cdp = await this.context.newCDPSession(this.page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: show ? "normal" : "minimized" } });
      if (show) await this.page.bringToFront();
    } catch { throw new AuthError(401, "Resident browser window control failed. Run local auth login; no basket write was retried."); }
    finally { await cdp?.detach().catch(() => {}); }
  }

  private async navigate(signal: AbortSignal): Promise<void> {
    this.candidates = [];
    if (this.current) this.candidates.push({wc:this.current.wcauthtoken,bearer:this.current.bearerToken});
    await raceAbort(this.page!.goto(`${ORIGIN}/gol-ui/trolley`, {waitUntil:"domcontentloaded",timeout:15_000}).catch(() => {}), signal);
  }

  private async authenticate(signal: AbortSignal, interactive: boolean, newGeneration: boolean): Promise<void> {
    this.authenticated = false;
    const tried = new Set<string>();
    const attempts = new Map<string,number>();
    let cookieState = "";
    for (;;) {
      check(signal);
      // A browser challenge may refresh cookies without changing either token.
      const latestCookies = JSON.stringify(await raceAbort(this.context!.cookies(),signal));
      if (latestCookies !== cookieState) { tried.clear(); cookieState = latestCookies; }
      for (const candidate of [...this.candidates].reverse()) {
        const key = `${candidate.wc}\n${candidate.bearer}`;
        if (tried.has(key) || (attempts.get(key) ?? 0) >= 3) continue;
        tried.add(key);
        attempts.set(key,(attempts.get(key) ?? 0)+1);
        try {
          await this.acceptCandidate(candidate,signal,newGeneration);
          return;
        } catch (error) {
          if (signal.aborted) throw error;
          if (!(error instanceof AuthError) && !(error instanceof ResponseValidationError)) throw error;
        }
      }
      // A normal shopping page may contain postcode or voucher fields. Verify
      // available credentials before treating an actual sign-in form as decisive.
      if (!interactive && await this.humanForm()) throw humanRequired();
      await this.wait(signal);
    }
  }

  private async humanForm(): Promise<boolean> {
    if (!this.page || this.closed) return true;
    try {
      const url = new URL(this.page.url());
      if (url.origin === "https://account.sainsburys.co.uk" && url.pathname.startsWith("/gol/login")) return true;
      return await this.page.locator('input[type="password"], input[autocomplete="one-time-code"]').first().isVisible();
    } catch { return false; }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.wake.delete(done); signal.removeEventListener("abort", cancel); resolve(); };
      const cancel = () => { clearTimeout(timer); this.wake.delete(done); signal.removeEventListener("abort", cancel); reject(new RequestCancelledError()); };
      const timer = setTimeout(done, 100);
      this.wake.add(done); signal.addEventListener("abort",cancel,{once:true});
      if (signal.aborted) cancel();
    });
  }

  private async verify(pair: Pair, signal: AbortSignal): Promise<string> {
    if (!this.page || new URL(this.page.url()).origin !== ORIGIN) throw humanRequired();
    const response = await this.fetch({url:`${ORIGIN}${PROFILE}`,method:"GET",headers:{}},pair,signal);
    return this.verifyIdentityResponse(response,pair);
  }

  private async acceptCandidate(candidate: Pair, signal: AbortSignal, newGeneration: boolean): Promise<void> {
    const userId = await this.verify(candidate, signal);
    const session: Session = {
      cookies: await captureCookies(this.context!), wcauthtoken:candidate.wc,bearerToken:candidate.bearer,
      userId,accountEmail:this.expectedEmail,capturedAt:Date.now(),
      authGeneration:newGeneration ? randomUUID() : this.current?.authGeneration ?? randomUUID(),
      browserManaged:true,
      userAgent:this.userAgent!,
    };
    check(signal);
    await saveSession(this.config.sessionPath,session,signal);
    check(signal);
    this.current = session; this.pair = candidate; this.authenticated = true;
  }

  private verifyIdentityResponse(response:ResidentResponse,pair:Pair):string {
    if (response.status !== 200 || !response.headers["content-type"]?.toLowerCase().includes("json")) throw humanRequired();
    let profile;
    try { profile = parseProfile(JSON.parse(response.body)); } catch { throw humanRequired(); }
    const id = parseWcauthtoken(pair.wc).userId;
    if (profile.user_id !== id || this.expectedUser && profile.user_id !== this.expectedUser ||
        typeof profile.email !== "string" || profile.email.toLowerCase() !== this.expectedEmail) throw humanRequired();
    return id;
  }

  private retailerPage(): boolean {
    try { return !!this.page && new URL(this.page.url()).origin === ORIGIN; }
    catch { return false; }
  }

  private async recoverRead(signal: AbortSignal): Promise<void> {
    // The running SPA may have rotated its tokens since login. Verify those
    // complete observed pairs before navigation discards the live page state.
    if (this.retailerPage()) for (const candidate of [...this.candidates].reverse()) {
      if (candidate.wc === this.pair?.wc && candidate.bearer === this.pair?.bearer) continue;
      try {
        await this.acceptCandidate(candidate,signal,false);
        return;
      } catch (error) {
        if (signal.aborted || !(error instanceof AuthError || error instanceof ResponseValidationError)) throw error;
      }
    }
    await this.window(false);
    await this.navigate(signal);
    await this.authenticate(signal,false,false);
    check(signal);
  }

  private async readOrRequest(input: ResidentRequest, signal: AbortSignal, allowRecovery = true): Promise<ResidentResponse> {
    const canRecover = allowRecovery && isRead(input);
    try {
      const result = await this.fetch(input,this.pair!,signal);
      if (!canRecover || result.status !== 401 && result.status !== 403) return result;
    } catch (error) {
      // A navigation between the Node precheck and renderer dispatch sends no
      // request. Treat it as authentication loss, with one silent read recovery.
      if (!canRecover || !(error instanceof AuthError)) throw error;
    }
    await this.recoverRead(signal);
    return this.fetch(input,this.pair!,signal);
  }

  private async guardAmendment(input:ResidentRequest,signal: AbortSignal): Promise<void> {
    const identity=await this.readOrRequest({url:`${ORIGIN}${PROFILE}`,method:"GET",headers:{}},signal);
    this.verifyIdentityResponse(identity,this.pair!);
    const read = async (url:string) => this.readOrRequest({url,method:"GET",headers:{}},signal);
    const basketUrl = new URL(`${ORIGIN}${BASKET}`);
    basketUrl.search = new URL(input.url).search;
    basketUrl.searchParams.set("calculate","true");
    const basket = await read(basketUrl.toString());
    const order = await read(`${ORIGIN}${ORDER_STATUS}`);
    try {
      const b:unknown = JSON.parse(basket.body);
      if (basket.status !== 200 || !b || typeof b !== "object" || !((b as Record<string,unknown>).is_in_amend_mode === false)) throw new Error();
      if (order.status === 404 || order.status === 204 || order.status === 200 && (!order.body.trim() || order.body.trim() === "null")) return;
      const o = parseOrderStatus(JSON.parse(order.body));
      if (order.status !== 200 || !o || o.is_in_amend_mode !== false) throw new Error();
    } catch { throw new ApiError(409,"Basket writes are unavailable unless fresh basket and order reads confirm amendment mode is off."); }
  }

  private async fetch(input: ResidentRequest, pair: Pair, signal: AbortSignal): Promise<ResidentResponse> {
    check(signal);
    if (!this.page) throw humanRequired();
    const id = randomUUID();
    const headers:Record<string,string> = {accept:"application/json","content-type":"application/json",wcauthtoken:pair.wc,authorization:`Bearer ${pair.bearer}`};
    for (const name of ["accept-language","enabled-feature-flags","x-http-method-override"]) {
      const value = Object.entries(input.headers).find(([key])=>key.toLowerCase()===name)?.[1];
      if (value !== undefined) headers[name] = value;
    }
    const cancel = () => { void this.page?.evaluate(rendererAbort,{id}).catch(()=>{}); };
    signal.addEventListener("abort",cancel,{once:true});
    try {
      const reply = await raceAbort(this.page.evaluate(rendererFetch,{id,url:input.url,method:input.method,headers,body:input.body,timeoutMs:15_000,maxBytes:4*1024*1024}),signal);
      if ("error" in reply) {
        if (reply.error === "origin") throw humanRequired();
        if (reply.error === "cancelled") throw new RequestCancelledError();
        if (reply.error === "deadline") throw new RequestTimeoutError();
        throw new ResponseValidationError("The resident browser could not complete a confined retailer request.");
      }
      return reply;
    } catch(error) {
      if(error instanceof AuthError || error instanceof RequestCancelledError || error instanceof RequestTimeoutError || error instanceof ResponseValidationError)throw error;
      throw new ResponseValidationError("The resident browser request failed; inspect the basket before retrying a write.");
    } finally {signal.removeEventListener("abort",cancel);}
  }
}

function isRead(input: ResidentRequest): boolean {
  return input.method === "GET" || input.method === "POST" && new URL(input.url).pathname === SLOT_LIST;
}

function validateRequest(input:ResidentRequest):ResidentRequest {
  let url:URL;
  try {url=new URL(input.url);}catch{throw new Error("Invalid resident retailer request.");}
  const method=input.method.toUpperCase();
  if(url.origin!==ORIGIN || url.username || url.password || url.hash ||
    !(method==="GET"&&READ_PATHS.has(url.pathname) || method==="POST"&&url.pathname===SLOT_LIST ||
      method==="POST"&&url.pathname===`${BASKET}/item` || method==="PUT"&&url.pathname===BASKET))throw new Error("Unsupported resident retailer operation.");
  const override=Object.entries(input.headers).find(([key])=>key.toLowerCase()==="x-http-method-override")?.[1];
  if (override !== undefined && !(method === "POST" && url.pathname === SLOT_LIST && override.toUpperCase() === "GET")) throw new Error("Unsupported resident method override.");
  if(input.body!==undefined && (typeof input.body!=="string" || Buffer.byteLength(input.body)>1024*1024))throw new Error("Invalid resident request body.");
  if (method === "GET" && input.body !== undefined) throw new Error("GET bodies are unavailable.");
  if (method === "PUT" || method === "POST" && url.pathname === `${BASKET}/item`) {
    validateBasketBody(input.body,method);
    validateWriteQuery(url);
  }
  if(method==="POST"&&url.pathname===SLOT_LIST) {
    if(override?.toUpperCase()!=="GET")throw new Error("Slot inspection requires read semantics.");
    validateSlotBody(input.body);
  }
  return {...input,url:url.toString(),method};
}

function validateWriteQuery(url:URL):void {
  const allowed = ["pick_time","store_number","slot_booked"];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error("Unsupported basket write query.");
  }
  const pick=url.searchParams.get("pick_time");
  const store=url.searchParams.get("store_number");
  const booked=url.searchParams.get("slot_booked");
  if (!pick || !Number.isFinite(Date.parse(pick)) || !store || !/^\d{4}$/.test(store) ||
      booked !== "true" && booked !== "false") throw new Error("Invalid basket write context.");
}

function validateSlotBody(body:string|undefined):void {
  try {
    const raw:unknown=JSON.parse(body ?? "");
    if(!raw || typeof raw!=="object" || Array.isArray(raw))throw new Error();
    const r=raw as Record<string,unknown>;
    if(Object.keys(r).some(key=>!["week_number","slot_type","product_uids","is_slot_locked","store_identifier","delivery_type"].includes(key))||
      !Number.isInteger(r.week_number)||Number(r.week_number)<1||Number(r.week_number)>4||
      !["DELIVERY","COLLECTION"].includes(String(r.slot_type))||typeof r.is_slot_locked!=="boolean"||
      typeof r.store_identifier!=="string"||!/^\d{4}$/.test(r.store_identifier)||
      !Array.isArray(r.product_uids)||r.product_uids.length<1||r.product_uids.length>1000||!r.product_uids.every(v=>typeof v==="string"&&/^\d{1,128}$/.test(v))||
      !Array.isArray(r.delivery_type)||r.delivery_type.length<1||r.delivery_type.length>2||!r.delivery_type.every(v=>v==="1hour"||v==="saver_slot"))throw new Error();
  }catch{throw new Error("Invalid slot inspection body.");}
}

function validateBasketBody(body:string|undefined,method:string):void {
  let raw:unknown;
  try {raw=JSON.parse(body ?? "");}catch{throw new Error("Invalid basket write body.");}
  const object=(value:unknown):Record<string,unknown>=>{if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("Invalid basket write body.");return value as Record<string,unknown>;};
  const root=object(raw);
  let lines:Record<string,unknown>[];
  if(method==="PUT"){
    if(Object.keys(root).some(key=>key!=="items")||!Array.isArray(root.items)||root.items.length<1||root.items.length>100)throw new Error("Invalid basket update list.");
    lines=root.items.map(object);
  }else lines=[root];
  for(const line of lines){
    const allowed=method==="PUT"?["product_uid","quantity","uom","selected_catchweight","item_uid","decreasing_quantity"]:["product_uid","quantity","uom","selected_catchweight"];
    if(Object.keys(line).some(key=>!allowed.includes(key)))throw new Error("Unsupported basket write fields.");
    if(typeof line.product_uid!=="string"||!/^\d+$/.test(normalizeIdentifier(line.product_uid)))throw new Error("Basket writes require a numeric SKU.");
    if(typeof line.quantity!=="number"||typeof line.uom!=="string")throw new Error("Invalid basket quantity or unit.");
    validateQuantity(line.quantity,line.uom);
    if(method==="POST" && line.quantity===0)throw new Error("Adding zero quantity is unavailable.");
    if(typeof line.selected_catchweight!=="string"||line.selected_catchweight.length>128||/[\x00-\x1f]/.test(line.selected_catchweight))throw new Error("Invalid catchweight selection.");
    if(method==="PUT"){
      normalizeIdentifier(line.item_uid,"basket line ID");
      if(line.decreasing_quantity!==undefined&&typeof line.decreasing_quantity!=="boolean")throw new Error("Invalid basket direction flag.");
    }
  }
}

async function captureCookies(context:BrowserContext):Promise<SessionCookie[]> {
  return (await context.cookies()).filter(c=>{const d=c.domain.replace(/^\./,"");return d==="sainsburys.co.uk"||d.endsWith(".sainsburys.co.uk");}).map(c=>({...c,expires:c.expires===-1?undefined:c.expires}));
}
function sameOwnedSession(a:Session,b:Session):boolean{return a.userId===b.userId&&a.accountEmail===b.accountEmail&&a.authGeneration===b.authGeneration;}
async function raceAbort<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  check(signal);let cancel!:()=>void;
  const aborted=new Promise<never>((_,reject)=>{cancel=()=>reject(new RequestCancelledError());signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();});
  try{return await Promise.race([pending,aborted]);}finally{signal.removeEventListener("abort",cancel);}
}

/** This closure is evaluated inside Chromium. It returns only bounded response data, never authentication headers. */
async function rendererFetch(args:{id:string;url:string;method:string;headers:Record<string,string>;body?:string;timeoutMs:number;maxBytes:number}):Promise<RendererReply>{
  const root=globalThis as unknown as {location:{origin:string};__sainsburysRequests?:Map<string,AbortController>};
  if(root.location.origin!=="https://www.sainsburys.co.uk"||new URL(args.url).origin!==root.location.origin)return{error:"origin"};
  const store=root.__sainsburysRequests??=new Map();
  const controller=new AbortController();store.set(args.id,controller);let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},args.timeoutMs);
  try{
    const response=await fetch(args.url,{method:args.method,headers:args.headers,body:args.body,credentials:"include",redirect:"manual",signal:controller.signal});
    if(response.type==="opaqueredirect"||response.redirected||response.status>=300&&response.status<400||response.url&&new URL(response.url).origin!==root.location.origin){void response.body?.cancel().catch(()=>{});return{error:"redirect"};}
    const headers:Record<string,string>={};for(const name of ["content-type","content-length"]){const value=response.headers.get(name);if(value!==null)headers[name]=value;}
    if(Number(headers["content-length"])>args.maxBytes){void response.body?.cancel().catch(()=>{});return{error:"size"};}
    const chunks:Uint8Array[]=[];let length=0;
    if(response.body){
      const reader=response.body.getReader();
      const cancelReader={handleEvent(){void reader.cancel().catch(()=>{});}};
      controller.signal.addEventListener("abort",cancelReader,{once:true});
      try{for(;;){if(controller.signal.aborted)return{error:timedOut?"deadline":"cancelled"};const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>args.maxBytes){void reader.cancel().catch(()=>{});return{error:"size"};}chunks.push(next.value);}}
      finally{controller.signal.removeEventListener("abort",cancelReader);reader.releaseLock();}
    }
    if(controller.signal.aborted)return{error:timedOut?"deadline":"cancelled"};
    const buffer=new Uint8Array(length);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
    return{status:response.status,headers,body:new TextDecoder().decode(buffer)};
  }catch{return{error:controller.signal.aborted?(timedOut?"deadline":"cancelled"):"network"};}
  finally{clearTimeout(timer);store.delete(args.id);}
}
function rendererAbort(args:{id:string}):void{(globalThis as unknown as {__sainsburysRequests?:Map<string,AbortController>}).__sainsburysRequests?.get(args.id)?.abort();}
