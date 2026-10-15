import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { loadSession,clearSession, type Session } from "../src/auth/session.js";
import { ApiError,AuthError,RequestCancelledError,ResponseValidationError } from "../src/client/http.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { chromium, type BrowserContext } from "playwright";
import { ResidentBrowser } from "../src/auth/resident-browser.js";
import { browserDataDir, launchContext } from "../src/auth/browser.js";
import { fakeSession } from "./_helpers.js";

async function setup(run: (fixture: ReturnType<typeof fakeBrowser>, engine: ResidentBrowser, dir: string) => Promise<void>, signedIn = true, sessionOverrides: Partial<Session> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sainsburys-resident-test-"));
  const fixture = fakeBrowser(signedIn);
  const config = {email:"dummy@example.invalid",sessionPath:join(dir,"session.json"),headed:true,baseUrl:"https://www.sainsburys.co.uk",loginBaseUrl:"https://account.sainsburys.co.uk"};
  await mkdir(browserDataDir(config.sessionPath,config.email),{recursive:true,mode:0o700});
  const engine = new ResidentBrowser({config,session:fakeSession({...sessionOverrides,accountEmail:config.email}),launch:fixture.launch});
  try { await run(fixture,engine,dir); } finally { await engine.close(); await rm(dir,{recursive:true,force:true}); }
}
function fakeBrowser(signedIn: boolean) {
  let currentUrl="about:blank", launches=0, closes=0, shows=0;
  let handler: (url:string,init:RequestInit) => Promise<Response> = async url => {
    if(url.endsWith("/customer/profile"))return new Response(JSON.stringify({user_id:"123456789",email:"dummy@example.invalid"}),{headers:{"content-type":"application/json"}});
    if(url.endsWith("/order/status"))return new Response(null,{status:204});
    if(url.includes("/basket") )return new Response(JSON.stringify({is_in_amend_mode:false}),{headers:{"content-type":"application/json"}});
    return new Response('{}',{headers:{"content-type":"application/json"}});
  };
  const calls:{url:string;init:RequestInit}[]=[];
  const state={signedIn,emit:true,inputs:[] as {name:string;type?:string;autocomplete?:string}[]};
  const visits:string[]=[];const windows:string[]=[];
  const context = new EventEmitter() as EventEmitter & Record<string,any>;
  const vm = createContext({navigator:{userAgent:"DummyBrowser/1"},location:{origin:"null"},AbortController,DOMException,TextDecoder,Uint8Array,Map,setTimeout,clearTimeout,URL,
    fetch:async(url:string,init:RequestInit)=>{calls.push({url,init});return handler(url,init);}});
  const setUrl=(url:string)=>{currentUrl=url;(vm as any).location.origin=new URL(url).origin;};
  const emitPair=()=>context.emit("request",{url:()=>"https://www.sainsburys.co.uk/groceries-api/test",headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:`Bearer ${fakeSession().bearerToken}`})});
  const page=Object.assign(new EventEmitter(),{
    url:()=>currentUrl,
    async goto(url:string){visits.push(url);setUrl(state.signedIn?url:"https://account.sainsburys.co.uk/gol/login");if(state.signedIn&&state.emit)emitPair();},
    async reload(){if(state.signedIn){setUrl("https://www.sainsburys.co.uk/gol-ui/trolley");emitPair();}},
    async bringToFront(){shows++;},
    async close(){},
    locator:(selector:string)=>({first(){return this;},async isVisible(){
      const fields=[...state.inputs,...(!state.signedIn?[{name:"password",type:"password",autocomplete:""}]:[])];
      return fields.some(field=>selector.split(",").some(part=>{
        const exact=part.match(/\[(name|type|autocomplete)="([^"]+)"\]/);
        if(exact)return (field as Record<string,string>)[exact[1]!]===exact[2];
        if(part.includes('[name*="code" i]'))return field.name.toLowerCase().includes("code");
        return false;
      }));
    }}),
    async evaluate(fn:Function,arg?:unknown){(vm as any).arg=arg;return runInContext(`(${fn.toString()})(arg)`,vm);},
  });
  Object.assign(context,{pages:()=>[page],newPage:async()=>page,cookies:async()=>fakeSession().cookies,addCookies:async()=>{},close:async()=>{closes++;},
    newCDPSession:async()=>({send:async(method:string,args:any)=>{if(args?.bounds)windows.push(args.bounds.windowState);return method==="Browser.getWindowForTarget"?{windowId:1}:{};},detach:async()=>{}})});
  return {state,page,context,calls,visits,windows,emitPair,setUrl,set handler(value:typeof handler){handler=value;},get handler(){return handler;},get launches(){return launches;},get closes(){return closes;},get shows(){return shows;},
    launch:async(opts:any)=>{assert.equal(opts.headless,false);assert.equal(opts.minimized,true);launches++;return context as unknown as BrowserContext;}};
}

describe("resident Chromium engine",()=>{
  it("reports sign-in route and actual form fields separately without exporting secrets",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});
    f.setUrl("https://account.sainsburys.co.uk/gol/login?secret=must-not-export");
    let report=await e.diagnoseAuthentication();
    assert.equal(report.page,"account_sign_in");
    assert.equal(report.passwordFieldVisible,false);
    assert.equal(report.mfaFieldVisible,false);
    f.state.inputs=[{name:"password",type:"password"},{name:"otp",autocomplete:"one-time-code"}];
    report=await e.diagnoseAuthentication();
    assert.equal(report.passwordFieldVisible,true);
    assert.equal(report.mfaFieldVisible,true);
    assert.doesNotMatch(JSON.stringify(report),/secret|https:|dummy@example|test-jwt|AbCdEfGh/);
  }));
  it("verifies a minimized existing profile, retains it, and uses renderer fetch",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});
    assert.equal(e.status().authenticated,true);assert.equal(f.shows,0);assert.equal(f.closes,0);
    const response=await e.request({url:"https://www.sainsburys.co.uk/groceries-api/gol-services/product/v1/product",method:"GET",headers:{cookie:"must-not-send",authorization:"Bearer stale"}});
    assert.equal(response.status,200);assert.equal(f.calls.at(-1)?.init.credentials,"include");
    assert.equal(new Headers(f.calls.at(-1)?.init.headers).get("cookie"),null);
    assert.equal(new Headers(f.calls.at(-1)?.init.headers).get("authorization"),`Bearer ${fakeSession().bearerToken}`);
  }));
  it("keeps a signed-out browser minimized and awaits one explicit manual login",()=>setup(async(f,e)=>{
    await assert.rejects(e.start({interactive:false,timeoutMs:100}),/login/i);
    assert.equal(f.shows,0);assert.equal(f.closes,0);assert.equal(e.status().needsLogin,true);
    f.state.signedIn=true;
    const s=await e.login({timeoutMs:500});
    assert.equal(s.accountEmail,"dummy@example.invalid");assert.equal(f.launches,1);assert.equal(f.shows,1);assert.equal(f.closes,0);
  },false));
});

const ORIGIN="https://www.sainsburys.co.uk";
const PRODUCT=`${ORIGIN}/groceries-api/gol-services/product/v1/product`;
const BASKET=`${ORIGIN}/groceries-api/gol-services/basket/v2/basket`;
const PROFILE="/customer/profile";
const WRITE_QUERY="?store_number=0123&slot_booked=false&pick_time=2099-10-15T10%3A00%3A00Z";
const change={product_uid:"12345",quantity:1,uom:"ea",selected_catchweight:""};
const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));

describe("resident operation confinement",()=>{
  it("allows bounded order history GETs while rejecting actions and extra query fields",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});
    const base = `${ORIGIN}/groceries-api/gol-services/order/v1/order`;
    for (const url of [`${base}?page_size=5&page_number=1`, `${base}/123?placed=true&deliveryPass=false`]) {
      assert.equal((await e.request({url,method:"GET",headers:{}})).status,200);
    }
    const before=f.calls.length;
    for (const [suffix,method] of [["/123","POST"],["/123/amend","GET"],["/123?amend=true","GET"],["?page_size=51","GET"],["?page_number=0","GET"],["?page_size=5&page_size=6","GET"],["/status/123","GET"]]) {
      await assert.rejects(e.request({url:base+suffix,method:method!,headers:{}}));
    }
    assert.equal(f.calls.length,before);
  }));
  it("rejects foreign origins, payment, amendments, booking and method overrides before any fetch",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const before=f.calls.length;
    for(const [url,method,headers] of [
      ["https://evil.test/groceries-api/gol-services/basket/v2/basket","PUT",{}],
      [`${ORIGIN}/groceries-api/gol-services/checkout/v1/checkout/payment/process`,"GET",{}],
      [`${ORIGIN}/groceries-api/gol-services/order/v1/order/123/amend`,"POST",{}],
      [`${ORIGIN}/groceries-api/gol-services/slot/v1/slot/reservation`,"POST",{}],
      [BASKET,"GET",{"X-HTTP-Method-Override":"DELETE"}],
    ] as const)await assert.rejects(e.request({url,method,headers}));
    assert.equal(f.calls.length,before);
  }));
  it("validates basket units, quantities, identifiers and extra fields before network access",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const before=f.calls.length;
    for(const body of [{...change,quantity:0},{...change,quantity:-1},{...change,quantity:0.5},{...change,quantity:100},
      {...change,uom:"lb"},{...change,product_uid:"line-id"},{...change,selected_catchweight:"bad\nweight"},{...change,payment:true}]){
      await assert.rejects(e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(body)}));
    }
    assert.equal(f.calls.length,before);
  }));
  it("preserves store/slot context in amendment guards and sends a valid mutation only once",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});
    await e.request({url:`${BASKET}/item?store_number=0123&slot_booked=true&pick_time=2099-10-15T10%3A00%3A00Z`,method:"POST",headers:{},body:JSON.stringify(change)});
    const guard=f.calls.find(c=>c.init.method==="GET"&&new URL(c.url).pathname.endsWith("/basket"))!;
    assert.equal(new URL(guard.url).searchParams.get("store_number"),"0123");assert.equal(new URL(guard.url).searchParams.get("slot_booked"),"true");assert.equal(new URL(guard.url).searchParams.get("calculate"),"true");
    assert.equal(f.calls.filter(c=>c.init.method==="POST").length,1);
  }));
  it("rejects active amendments and malformed order status before mutation",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;
    for(const order of [{},{order_uid:"123",is_cutoff:false,is_in_amend_mode:true}]){
      f.handler=async(url,init)=>url.endsWith("/order/status")?new Response(JSON.stringify(order),{headers:{"content-type":"application/json"}}):original(url,init);
      await assert.rejects(e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)}),ApiError);
    }
    f.handler=async(url,init)=>new URL(url).pathname.endsWith("/basket")?new Response('{"is_in_amend_mode":true}',{headers:{"content-type":"application/json"}}):original(url,init);
    await assert.rejects(e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)}),ApiError);
    assert.equal(f.calls.filter(c=>c.init.method==="POST").length,0);
  }));
  it("refuses redirects, bounds response streams, and never exports authentication headers",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});
    f.handler=async()=>new Response(null,{status:302,headers:{location:"https://evil.test/"}});
    await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),ResponseValidationError);
    assert.equal(f.calls.at(-1)?.init.redirect,"manual");
    f.handler=async()=>new Response(new Uint8Array(4*1024*1024+1));
    await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),ResponseValidationError);
    f.handler=async()=>new Response('{}',{headers:{"content-type":"application/json","set-cookie":"secret=dummy","authorization":"Bearer hidden"}});
    const r=await e.request({url:PRODUCT,method:"GET",headers:{"user-agent":"spoof",origin:"https://evil.test"}});
    assert.deepEqual(Object.keys(r.headers),["content-type"]);assert.equal(new Headers(f.calls.at(-1)?.init.headers).get("user-agent"),null);
  }));
});

describe("resident session recovery and cancellation",()=>{
  it("retries a rejected GET once after minimized identity-verified reload, preserving the epoch",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const epoch=e.getSession()!.authGeneration;const original=f.handler;let reads=0;
    f.handler=async(url,init)=>url===PRODUCT?new Response('{}',{status:++reads===1?401:200,headers:{"content-type":"application/json"}}):original(url,init);
    const response=await e.request({url:PRODUCT,method:"GET",headers:{}});
    assert.equal(response.status,200);assert.equal(reads,2);assert.equal(f.shows,0);assert.equal(e.getSession()!.authGeneration,epoch);
  }));
  it("does not replay POST/PUT after authentication failure",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;let writes=0;const navigations=f.visits.length;
    f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer rotated"})});
    f.handler=async(url,init)=>init.method==="POST"||init.method==="PUT"?(writes++,new Response('{}',{status:401,headers:{"content-type":"application/json"}})):original(url,init);
    const r=await e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)});
    assert.equal(r.status,401);assert.equal(writes,1);assert.equal(f.visits.length,navigations);
  }));
  it("falls back to explicit manual login without showing a window if read recovery reaches password/MFA",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;
    f.handler=async(url,init)=>{if(url===PRODUCT){f.state.signedIn=false;return new Response('{}',{status:401});}return original(url,init);};
    await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),AuthError);
    assert.equal(e.status().needsLogin,true);assert.equal(f.shows,0);
  }));
  it("rejects wrong identity before saving any credentials",()=>setup(async(f,e,dir)=>{
    f.handler=async()=>new Response('{"user_id":"999","email":"other@example.invalid"}',{headers:{"content-type":"application/json"}});
    await assert.rejects(e.start({interactive:false,timeoutMs:25}),AuthError);
    assert.equal(await loadSession(join(dir,"session.json")),null);assert.equal(e.status().authenticated,false);
  }));
  it("never combines partial credential headers from different requests",()=>setup(async(f,e)=>{
    f.state.emit=false;
    f.handler=async(_url,init)=>new Response(JSON.stringify({user_id:"123456789",email:"dummy@example.invalid"}),{status:new Headers(init.headers).get("authorization")==="Bearer fresh"?200:401,headers:{"content-type":"application/json"}});
    const login=e.login({timeoutMs:500});
    await pause(10);
    const emit=(headers:Record<string,string>,url=`${ORIGIN}/groceries-api/test`)=>f.context.emit("request",{url:()=>url,headers:()=>headers});
    emit({wcauthtoken:fakeSession().wcauthtoken});emit({authorization:"Bearer fresh"});
    emit({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer fresh"},"https://evil.test/groceries-api/test");
    await pause(15);assert.equal(e.status().authenticated,false);
    emit({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer fresh"});
    await login;assert.equal(e.status().authenticated,true);
  }));
  it("aborts renderer fetch and leaves a queued cancelled mutation unsent",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;let started!:()=>void;const ready=new Promise<void>(done=>{started=done;});let aborted=false;
    f.handler=async(url,init)=>{if(url!==PRODUCT)return original(url,init);started();return new Promise((_,reject)=>init.signal!.addEventListener("abort",()=>{aborted=true;reject(new Error("dummy-secret"));},{once:true}));};
    const activeController=new AbortController();const active=e.request({url:PRODUCT,method:"GET",headers:{}},activeController.signal);await ready;
    const queuedController=new AbortController();const queued=e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)},queuedController.signal);
    queuedController.abort();await assert.rejects(queued,RequestCancelledError);
    activeController.abort();await assert.rejects(active,RequestCancelledError);await pause(5);
    assert.equal(aborted,true);assert.equal(f.calls.filter(c=>c.init.method==="POST").length,0);
  }));
  it("minimizes after interrupted explicit login and never resurrects logged-out disk state on close",()=>setup(async(f,e,dir)=>{
    f.state.signedIn=false;const controller=new AbortController();const login=e.login({signal:controller.signal,timeoutMs:500});
    await pause(10);controller.abort();await assert.rejects(login,RequestCancelledError);await pause(5);assert.equal(f.windows.at(-1),"minimized");
    f.state.signedIn=true;await e.login({timeoutMs:500});
    await clearSession(join(dir,"session.json"));await e.close();assert.equal(await loadSession(join(dir,"session.json")),null);
  }));
  it("refuses a missing profile before launching and rejects invalid email immediately",()=>setup(async(f,_e,dir)=>{
    const config={email:"dummy@example.invalid",sessionPath:join(dir,"missing","session.json"),headed:true,baseUrl:ORIGIN,loginBaseUrl:"https://account.sainsburys.co.uk"};
    const e=new ResidentBrowser({config,session:fakeSession({accountEmail:config.email}),launch:f.launch});
    await assert.rejects(e.start({interactive:false,timeoutMs:50}),AuthError);assert.equal(f.launches,0);await e.close();
    assert.throws(()=>new ResidentBrowser({config:{...config,email:"bad"},launch:f.launch}),AuthError);
  }));
});

describe("resident lifecycle regressions",()=>{
  it("recovers one basket GET500 in a fresh minimized page in the same context with a verified pair and fixed epoch",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const epoch=e.getSession()!.authGeneration;const original=f.handler;
    const fresh=fakeBrowser(true);let created=0,oldClosed=0;
    f.page.close=async()=>{oldClosed++;};f.context.newPage=async()=>{created++;return fresh.page;};
    let resolveHeaders!:(headers:Record<string,string>)=>void;
    const delayedHeaders=new Promise<Record<string,string>>(done=>{resolveHeaders=done;});
    f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({}),allHeaders:()=>delayedHeaders,frame:()=>({page:()=>f.page})});
    fresh.context.on("request",()=>f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer page-refreshed"}),frame:()=>({page:()=>fresh.page})}));
    const goto=fresh.page.goto.bind(fresh.page);
    fresh.page.goto=async(url:string)=>{
      await goto(url);resolveHeaders({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer delayed-old-page"});
      f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer stale-old-page"}),frame:()=>({page:()=>f.page})});
      await pause(0);
    };
    f.handler=async(url,init)=>url===BASKET?new Response('{}',{status:500}):original(url,init);
    const response=await e.request({url:BASKET,method:"GET",headers:{}});
    assert.equal(response.status,200);assert.equal(created,1);assert.equal(oldClosed,1);assert.equal(f.launches,1);
    assert.equal(f.shows+fresh.shows,0);assert.equal(e.getSession()!.authGeneration,epoch);
    assert.equal(e.getSession()!.bearerToken,"page-refreshed");
    assert.equal(f.calls.filter(c=>c.url===BASKET).length,1);assert.equal(fresh.calls.filter(c=>c.url===BASKET).length,1);
  }));
  it("rejects fresh-page identity mismatch without retrying the basket read",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;const fresh=fakeBrowser(true);
    f.page.close=async()=>{};f.context.newPage=async()=>fresh.page;
    fresh.state.inputs=[{name:"secret",type:"password"}];
    fresh.handler=async()=>new Response('{"user_id":"999","email":"other@example.invalid"}',{headers:{"content-type":"application/json"}});
    f.handler=async(url,init)=>url===BASKET?new Response('{}',{status:500}):original(url,init);
    await assert.rejects(e.request({url:BASKET,method:"GET",headers:{}}),AuthError);
    assert.equal(e.getSession(),undefined);assert.equal(fresh.calls.filter(c=>c.url===BASKET).length,0);assert.equal(f.shows+fresh.shows,0);
  }));
  it("closes a late fresh page after cancellation without navigation, persistence or retry",()=>setup(async(f,e,dir)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;const saved=await loadSession(join(dir,"session.json"));
    const fresh=fakeBrowser(true);let resolve!: (page:typeof fresh.page)=>void,ready!:()=>void,closed=0;
    const opening=new Promise<typeof fresh.page>(done=>{resolve=done;});const started=new Promise<void>(done=>{ready=done;});
    fresh.page.close=async()=>{closed++;};f.context.newPage=()=>{ready();return opening;};
    f.handler=async(url,init)=>url===BASKET?new Response('{}',{status:500}):original(url,init);
    const controller=new AbortController();const request=e.request({url:BASKET,method:"GET",headers:{}},controller.signal);
    await started;controller.abort();await assert.rejects(request,RequestCancelledError);
    assert.equal(await Promise.race([e.close().then(()=>"closed"),pause(100).then(()=>"blocked")]),"closed");
    resolve(fresh.page);await pause(5);
    assert.equal(closed,1);assert.equal(fresh.visits.length,0);assert.equal(fresh.calls.length,0);
    assert.deepEqual(await loadSession(join(dir,"session.json")),saved);
  }));
  it("does not fresh-page recover other GET500s or basket writes",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;let created=0;
    f.context.newPage=async()=>{created++;return f.page;};
    f.handler=async(url,init)=>url===PRODUCT||init.method==="POST"||init.method==="PUT"?new Response('{}',{status:500}):original(url,init);
    assert.equal((await e.request({url:PRODUCT,method:"GET",headers:{}})).status,500);
    assert.equal((await e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)})).status,500);
    assert.equal((await e.request({url:`${BASKET}${WRITE_QUERY}`,method:"PUT",headers:{},body:JSON.stringify({items:[{...change,item_uid:"line-1"}]})})).status,500);
    assert.equal(created,0);assert.equal(f.calls.filter(c=>c.init.method==="POST").length,1);assert.equal(f.calls.filter(c=>c.init.method==="PUT").length,1);
  }));
  it("returns a second basket GET500 after exactly one fresh-page recovery",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;const fresh=fakeBrowser(true);let created=0;
    f.page.close=async()=>{};f.context.newPage=async()=>{created++;return fresh.page;};
    f.handler=fresh.handler=async(url,init)=>url===BASKET?new Response('{}',{status:500}):original(url,init);
    assert.equal((await e.request({url:BASKET,method:"GET",headers:{}})).status,500);
    assert.equal(created,1);assert.equal(f.calls.filter(c=>c.url===BASKET).length+fresh.calls.filter(c=>c.url===BASKET).length,2);
  }));
  it("does not fresh-page recover after a request already used its authentication recovery",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;let created=0,reads=0;
    f.context.newPage=async()=>{created++;return f.page;};
    f.handler=async(url,init)=>url===BASKET?new Response('{}',{status:++reads===1?401:500}):original(url,init);
    assert.equal((await e.request({url:BASKET,method:"GET",headers:{}})).status,500);assert.equal(created,0);assert.equal(reads,2);
  }));
  async function failedRecovery(f:ReturnType<typeof fakeBrowser>,e:ResidentBrowser) {
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;
    f.handler=async(url,init)=>{
      if(url===PRODUCT){f.state.signedIn=false;return new Response('{}',{status:401});}
      return original(url,init);
    };
    await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),AuthError);
    assert.equal(e.getSession(),undefined);
    f.handler=original;f.state.signedIn=true;f.setUrl(`${ORIGIN}/gol-ui/trolley`);
  }
  it("silently verifies a resumed retained browser after failed recovery while keeping unauthenticated writes blocked",()=>setup(async(f,e,dir)=>{
    await failedRecovery(f,e);const visits=f.visits.length;const before=f.calls.length;
    f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer resumed"})});
    await assert.rejects(e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)}),AuthError);
    assert.equal(f.calls.length,before);
    const saved=await loadSession(join(dir,"session.json"));
    assert.equal((await e.request({url:PRODUCT,method:"GET",headers:{}})).status,200);
    assert.equal(e.getSession()!.bearerToken,"resumed");assert.equal(f.visits.length,visits);assert.equal(f.shows,0);
    assert.deepEqual(e.getSessionBinding(),{userId:saved!.userId,authGeneration:saved!.authGeneration});
  }));
  it("does not adopt a wrong-account pair while recovering an unauthenticated retained browser",()=>setup(async(f,e,dir)=>{
    await failedRecovery(f,e);const saved=await loadSession(join(dir,"session.json"));
    f.state.inputs=[{name:"secret",type:"password"}];
    f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer wrong-account"})});
    f.handler=async(_url,init)=>new Headers(init.headers).get("authorization")==="Bearer wrong-account"?
      new Response('{"user_id":"999","email":"other@example.invalid"}',{headers:{"content-type":"application/json"}}):new Response('{}',{status:401});
    await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),AuthError);
    assert.equal(e.getSession(),undefined);assert.equal(f.shows,0);
    assert.deepEqual(e.getSessionBinding(),{userId:saved!.userId,authGeneration:saved!.authGeneration});
    assert.deepEqual(await loadSession(join(dir,"session.json")),saved);
  }));
  it("cancels resumed-browser credential verification without authenticating or writing late",()=>setup(async(f,e,dir)=>{
    await failedRecovery(f,e);const saved=await loadSession(join(dir,"session.json"));
    f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer resumed"})});
    let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});let cancelled=false;
    f.handler=async(_url,init)=>{ready();return new Promise((_,reject)=>init.signal!.addEventListener("abort",()=>{cancelled=true;reject(new Error("dummy"));},{once:true}));};
    const controller=new AbortController();const pending=e.request({url:PRODUCT,method:"GET",headers:{}},controller.signal);
    await started;controller.abort();await assert.rejects(pending,RequestCancelledError);await pause(5);
    assert.equal(cancelled,true);assert.equal(e.getSession(),undefined);assert.equal(f.shows,0);
    assert.deepEqual(await loadSession(join(dir,"session.json")),saved);
  }));
  it("attempts only one recovery when an unauthenticated browser resumes but its read remains rejected",()=>setup(async(f,e)=>{
    await failedRecovery(f,e);const original=f.handler;const visits=f.visits.length;let reads=0;
    f.handler=async(url,init)=>url===PRODUCT?(reads++,new Response('{}',{status:401})):original(url,init);
    assert.equal((await e.request({url:PRODUCT,method:"GET",headers:{}})).status,401);
    assert.equal(reads,1);assert.equal(f.visits.length,visits+1);assert.equal(f.shows,0);
  }));
  it("verifies a newer observed credential pair before navigating on a rejected read",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;const visits=f.visits.length;
    const epoch=e.getSession()!.authGeneration;
    f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer rotated"})});
    f.handler=async(url,init)=>url===PRODUCT?new Response('{}',{status:new Headers(init.headers).get("authorization")==="Bearer rotated"?200:401,headers:{"content-type":"application/json"}}):original(url,init);
    const response=await e.request({url:PRODUCT,method:"GET",headers:{}});
    assert.equal(response.status,200);assert.equal(f.visits.length,visits);assert.equal(f.shows,0);
    assert.equal(e.getSession()!.bearerToken,"rotated");assert.equal(e.getSession()!.authGeneration,epoch);
    assert.equal(f.calls.filter(call=>call.url===PRODUCT).length,2);
  }));
  it("rejects a rotated pair with a different verified identity before falling back to navigation",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;const visits=f.visits.length;
    f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer other-account"})});
    f.handler=async(url,init)=>{
      if(url.endsWith(PROFILE)&&new Headers(init.headers).get("authorization")==="Bearer other-account")return new Response('{"user_id":"999","email":"other@example.invalid"}',{headers:{"content-type":"application/json"}});
      return url===PRODUCT?new Response('{}',{status:401}):original(url,init);
    };
    const response=await e.request({url:PRODUCT,method:"GET",headers:{}});
    assert.equal(response.status,401);assert.equal(f.visits.length,visits+1);
    assert.equal(e.getSession()!.bearerToken,fakeSession().bearerToken);assert.equal(f.shows,0);
  }));
  it("rechecks unchanged tokens when the browser refreshes only its cookies",()=>setup(async(f,e)=>{
    f.state.emit=false;let revision=0;
    f.context.cookies=async()=>fakeSession().cookies.map(cookie=>cookie.name==="_abck"?{...cookie,value:`dummy-${revision}`}:cookie);
    f.handler=async()=>{
      if(!revision){setTimeout(()=>{revision=1;},5);return new Response('{}',{status:401});}
      return new Response('{"user_id":"123456789","email":"dummy@example.invalid"}',{headers:{"content-type":"application/json"}});
    };
    await e.start({interactive:false,timeoutMs:500});assert.equal(e.status().authenticated,true);
    assert.equal(e.getSession()!.cookies.find(c=>c.name==="_abck")!.value,"dummy-1");
  }));
  it("reopens only on explicit login after unexpected browser closure",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});f.context.emit("close");
    await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),AuthError);assert.equal(f.launches,1);assert.equal(f.shows,0);
    await e.login({timeoutMs:500});assert.equal(f.launches,2);assert.equal(f.shows,1);assert.equal(e.status().authenticated,true);
    assert.equal(f.context.listenerCount("request"),1);
  }));
  it("permits a single recovery for the exact slot-inspection POST and no other POST",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;let reads=0;
    const url=`${ORIGIN}/groceries-api/gol-services/slot/v2/slots`;
    f.handler=async(path,init)=>path===url?new Response('{"slots":[]}',{status:++reads===1?401:200,headers:{"content-type":"application/json"}}):original(path,init);
    const r=await e.request({url,method:"POST",headers:{"X-HTTP-Method-Override":"GET"},body:JSON.stringify({week_number:1,slot_type:"DELIVERY",product_uids:["12345"],is_slot_locked:false,store_identifier:"0123",delivery_type:["1hour"]})});
    assert.equal(r.status,200);assert.equal(reads,2);assert.equal(f.shows,0);
  }));
  it("never loops on a second GET authentication rejection",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;let reads=0;
    f.handler=async(url,init)=>url===PRODUCT?(reads++,new Response('{}',{status:401})):original(url,init);
    assert.equal((await e.request({url:PRODUCT,method:"GET",headers:{}})).status,401);assert.equal(reads,2);
  }));
  it("close cancels a blocked response stream promptly",()=>setup(async(f,e,dir)=>{
    await e.start({interactive:false,timeoutMs:500});let started!:()=>void;const ready=new Promise<void>(done=>{started=done;});let cancelled=false;
    f.handler=async()=>{started();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-type":"application/json"}});};
    const request=e.request({url:PRODUCT,method:"GET",headers:{}});await ready;
    // This owner-only close does not need a cookie save; removing disk state also
    // makes the regression prove that close cannot resurrect a logged-out session.
    await clearSession(join(dir,"session.json"));
    const closed=e.close();await assert.rejects(request,RequestCancelledError);await closed;assert.equal(cancelled,true);
  }));
  it("redacts browser call logs before they can reach a tool result",()=>setup(async(f,e)=>{
    f.page.evaluate=async()=>{throw new Error("secret-cookie and bearer-token in browser call log");};
    await assert.rejects(e.start({interactive:false,timeoutMs:100}),(error:Error)=>{
      assert.doesNotMatch(error.message,/secret-cookie|bearer-token/);return true;
    });
  }));
});

describe("resident startup and account ownership",()=>{
  it("verifies current identity again before every raw basket write",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const original=f.handler;
    f.handler=async(url,init)=>url.endsWith(PROFILE)?new Response('{"user_id":"999","email":"other@example.invalid"}',{headers:{"content-type":"application/json"}}):original(url,init);
    await assert.rejects(e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)}),AuthError);
    assert.equal(f.calls.filter(c=>c.init.method==="POST").length,0);
  }));
  it("closes a late browser opening after startup cancellation before releasing ownership",()=>setup(async(f,_unused,dir)=>{
    let resolve!: (context:BrowserContext)=>void;
    const opening=new Promise<BrowserContext>(done=>{resolve=done;});
    const config={email:"dummy@example.invalid",sessionPath:join(dir,"session.json"),headed:true,baseUrl:ORIGIN,loginBaseUrl:"https://account.sainsburys.co.uk"};
    const e=new ResidentBrowser({config,session:fakeSession({accountEmail:config.email}),launch:async()=>opening});
    const controller=new AbortController();const started=e.start({interactive:false,signal:controller.signal,timeoutMs:500});
    await pause(5);controller.abort();await assert.rejects(started,RequestCancelledError);
    let finished=false;const closing=e.close().then(()=>{finished=true;});await pause(5);assert.equal(finished,false);
    resolve(f.context as unknown as BrowserContext);await closing;assert.equal(f.closes,1);
  }));
  it("does not re-probe a rejected pair because its own verification request was observed",()=>setup(async(f,e)=>{
    let probes=0;
    f.handler=async(_url,init)=>{probes++;f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/gol-services/customer/v1/customer/profile`,headers:()=>Object.fromEntries(new Headers(init.headers).entries())});return new Response('{}',{status:401});};
    await assert.rejects(e.start({interactive:false,timeoutMs:40}),AuthError);assert.equal(probes,1);
  }));
});

it("launches Chromium with a bounded startup deadline and only the minimize flag",()=>setup(async(_f,_e,dir)=>{
  const launch=mock.method(chromium,"launchPersistentContext",async(_directory:string,opts:Record<string,unknown>)=>{
    assert.equal(opts.timeout,15_000);assert.deepEqual(opts.args,["--start-minimized"]);assert.equal(opts.headless,false);
    return {close:async()=>{}} as unknown as BrowserContext;
  });
  try {const context=await launchContext({sessionPath:join(dir,"session.json"),accountEmail:"dummy@example.invalid",headless:false,minimized:true});await context.close();}
  finally{launch.mock.restore();}
}));

it("rejects unknown, duplicate and malformed basket write queries before any network",()=>setup(async(f,e)=>{
  await e.start({interactive:false,timeoutMs:500});const before=f.calls.length;
  for(const query of [
    `${WRITE_QUERY}&order_uid=123`,`${WRITE_QUERY}&amend=true`,`${WRITE_QUERY}&store_number=9999`,
    "?store_number=123&slot_booked=false&pick_time=2099-10-15T10%3A00%3A00Z",
    "?store_number=0123&slot_booked=1&pick_time=2099-10-15T10%3A00%3A00Z",
    "?store_number=0123&slot_booked=false&pick_time=not-a-date",
    "?store_number=0123&slot_booked=false", "",
  ])await assert.rejects(e.request({url:`${BASKET}/item${query}`,method:"POST",headers:{},body:JSON.stringify(change)}));
  assert.equal(f.calls.length,before);
}));

describe("resident page navigation and form detection",()=>{
  it("restores missing cookies without overwriting a newer profile cookie or restoring expired cookies",()=>setup(async(f,e)=>{
    const fresh={...fakeSession().cookies[0]!,value:"new-profile-value"};
    const added:Session["cookies"]=[];
    f.context.cookies=async()=>[fresh];
    f.context.addCookies=async(cookies:Session["cookies"])=>{added.push(...cookies);};
    await e.start({interactive:false,timeoutMs:500});
    assert.equal(added.some(cookie=>cookie.name===fresh.name&&cookie.path===fresh.path&&cookie.domain===fresh.domain),false);
    assert.equal(added.some(cookie=>cookie.name==="JSESSIONID"),true);
    assert.equal(added.some(cookie=>cookie.name==="expired"),false);
    assert.equal(added.some(cookie=>cookie.name===fresh.name&&cookie.path==="/other"),true);
    assert.equal(added.some(cookie=>cookie.name===fresh.name&&cookie.domain===".sainsburys.co.uk"),true);
  },true,{cookies:[...fakeSession().cookies,
    {name:"expired",value:"old",domain:"www.sainsburys.co.uk",path:"/",expires:1},
    {...fakeSession().cookies[0]!,path:"/other"},
    {...fakeSession().cookies[0]!,domain:".sainsburys.co.uk"},
  ]}));
  for(const origin of ["https://account.sainsburys.co.uk/gol/login","https://outside.invalid/"]){
    it(`silently recovers a read after idle navigation to ${new URL(origin).hostname}`,()=>setup(async(f,e)=>{
      await e.start({interactive:false,timeoutMs:500});const visits=f.visits.length;
      f.setUrl(origin);
      assert.equal((await e.request({url:PRODUCT,method:"GET",headers:{}})).status,200);
      assert.equal(f.visits.length,visits+1);assert.equal(f.shows,0);
    }));
    it(`rejects a write before guards or fetch after idle navigation to ${new URL(origin).hostname}`,()=>setup(async(f,e)=>{
      await e.start({interactive:false,timeoutMs:500});const calls=f.calls.length;
      f.setUrl(origin);
      await assert.rejects(e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)}),AuthError);
      assert.equal(f.calls.length,calls);assert.equal(f.shows,0);
    }));
  }
  it("leaves idle-navigation recovery at an actual sign-in form minimized and requires human login",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});f.state.signedIn=false;
    f.setUrl("https://account.sainsburys.co.uk/gol/login");const before=f.calls.length;
    await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),AuthError);
    assert.equal(f.calls.length,before);assert.equal(e.status().needsLogin,true);assert.equal(f.shows,0);
  }));
  it("classifies a renderer-origin race as definite authentication failure without sending the write",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const evaluate=f.page.evaluate.bind(f.page);
    f.page.evaluate=async(fn:Function,arg?:unknown)=>{
      if((arg as {method?:string})?.method==="POST")f.setUrl("https://account.sainsburys.co.uk/gol/login");
      return evaluate(fn,arg);
    };
    await assert.rejects(e.request({url:`${BASKET}/item${WRITE_QUERY}`,method:"POST",headers:{},body:JSON.stringify(change)}),AuthError);
    assert.equal(f.calls.filter(call=>call.init.method==="POST").length,0);
  }));
  it("recovers one renderer-origin race during a read without showing the browser",()=>setup(async(f,e)=>{
    await e.start({interactive:false,timeoutMs:500});const evaluate=f.page.evaluate.bind(f.page);let raced=false;
    f.page.evaluate=async(fn:Function,arg?:unknown)=>{
      if(!raced&&(arg as {url?:string})?.url===PRODUCT){raced=true;f.setUrl("https://account.sainsburys.co.uk/gol/login");}
      return evaluate(fn,arg);
    };
    assert.equal((await e.request({url:PRODUCT,method:"GET",headers:{}})).status,200);assert.equal(f.shows,0);
  }));
  for(const name of ["postcode","promoCode","voucherCode"]){
    it(`verifies cached identity before treating a visible ${name} input as login`,()=>setup(async(f,e)=>{
      f.state.inputs=[{name,type:"text"}];await e.start({interactive:false,timeoutMs:500});
      assert.equal(e.status().authenticated,true);assert.equal(f.shows,0);
    }));
  }
  it("waits for fresh credentials beside a postcode field rather than declaring MFA",()=>setup(async(f,e)=>{
    f.state.inputs=[{name:"postcode",type:"text"}];f.state.emit=false;
    f.handler=async(_url,init)=>new Response('{"user_id":"123456789","email":"dummy@example.invalid"}',{status:new Headers(init.headers).get("authorization")==="Bearer fresh"?200:401,headers:{"content-type":"application/json"}});
    const started=e.start({interactive:false,timeoutMs:500});
    setTimeout(()=>f.context.emit("request",{url:()=>`${ORIGIN}/groceries-api/test`,headers:()=>({wcauthtoken:fakeSession().wcauthtoken,authorization:"Bearer fresh"})}),20);
    await started;assert.equal(e.status().authenticated,true);
  }));
  it("lets a transient account password page silently resume with unchanged cookies and credentials",()=>setup(async(f,e)=>{
    const goto=f.page.goto.bind(f.page);
    f.page.goto=async(url:string)=>{
      await goto(url);
      f.state.inputs=[{name:"password",type:"password"}];
      f.setUrl("https://account.sainsburys.co.uk/temporary-sign-in");
      setTimeout(()=>{f.state.inputs=[];f.setUrl(url);},30);
    };
    const epoch=e.getSessionBinding()!.authGeneration;
    await e.start({interactive:false,timeoutMs:500});
    assert.equal(e.status().authenticated,true);assert.equal(f.shows,0);assert.equal(f.launches,1);
    assert.equal(e.getSession()!.authGeneration,epoch);
    assert.equal(e.getSession()!.bearerToken,fakeSession().bearerToken);
    assert.equal(f.calls.filter(call=>call.url.endsWith(PROFILE)).length,1);
  },true,{authGeneration:"00000000-0000-4000-8000-000000000001"}));
  it("cancels silent sign-in stabilization without showing a login window",()=>setup(async(f,e)=>{
    f.state.signedIn=false;
    const controller=new AbortController();
    const pending=e.start({interactive:false,signal:controller.signal,timeoutMs:500});
    const timer=setTimeout(()=>controller.abort(),20);
    try { await assert.rejects(pending,RequestCancelledError); }
    finally { clearTimeout(timer); }
    assert.equal(e.status().needsLogin,true);assert.equal(f.shows,0);assert.equal(f.calls.length,0);
  }));
  it("keeps silent sign-in stabilization inside a shorter operation deadline",()=>setup(async(f,e)=>{
    f.state.signedIn=false;const began=Date.now();
    await assert.rejects(e.start({interactive:false,timeoutMs:30}),AuthError);
    assert.ok(Date.now()-began<500,"The settling period must not extend the operation deadline");
    assert.equal(f.visits.length,1);assert.equal(f.shows,0);assert.equal(f.calls.length,0);
  }));
  for(const input of [{name:"secret",type:"password"},{name:"verification",type:"text",autocomplete:"one-time-code"}]){
    it(`accepts verified identity before a stale visible ${input.type==="password"?"password":"MFA"} form`,()=>setup(async(f,e)=>{
      f.state.inputs=[input];await e.start({interactive:false,timeoutMs:500});
      assert.equal(e.status().authenticated,true);assert.equal(f.shows,0);
    }));
    it(`requires explicit login for a real ${input.type==="password"?"password":"MFA"} form after credential verification fails`,()=>setup(async(f,e)=>{
      f.state.inputs=[input];f.handler=async()=>new Response('{}',{status:401});
      await assert.rejects(e.start({interactive:false,timeoutMs:500}),AuthError);
      assert.equal(e.status().needsLogin,true);assert.equal(f.shows,0);
    }));
    it(`stops after a stable ${input.type==="password"?"password":"MFA"} form without another navigation or read retry`,()=>setup(async(f,e)=>{
      await e.start({interactive:false,timeoutMs:500});const visits=f.visits.length,calls=f.calls.length;
      f.state.inputs=[input];f.handler=async()=>new Response('{}',{status:401});
      await assert.rejects(e.request({url:PRODUCT,method:"GET",headers:{}}),AuthError);
      assert.equal(f.visits.length,visits+1);assert.equal(f.calls.length,calls+2);
      assert.equal(f.calls.slice(calls).filter(call=>call.url===PRODUCT).length,1);
      assert.equal(e.status().needsLogin,true);assert.equal(f.shows,0);
    }));
  }
});
