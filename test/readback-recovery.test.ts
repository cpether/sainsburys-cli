import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError, GroceriesClient, RETAILER_ORIGIN } from "../src/client/http.js";
import { applyBasketPlan, BasketApplyError, createBasketPlan, type PlanContext } from "../src/basket/plan.js";
import { printError } from "../src/cli/output.js";
import { fakeSession } from "./_helpers.js";

type ReadResult = number | "network" | "schema" | "mismatch" | "timeout" | "state";
function fixture(results: ReadResult[]) {
  const original = { basket_id: "basket-1", total_price: 0.65, is_in_amend_mode: false, items: [{ item_uid: "line-1", quantity: 1, uom: "ea", subtotal_price: 0.65, product: { sku: "7515858", name: "Dummy pot" } }] };
  let writes = 0;
  let readbacks = 0;
  const methods: string[] = [];
  const client = new GroceriesClient({ session: fakeSession(), baseUrl: RETAILER_ORIGIN, fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    methods.push(method);
    if (path.endsWith("/status")) return new Response(null, { status: 404 });
    if (path.includes("product/v1/product")) return Response.json({ products: [{ product_uid: "7515858", name: "Dummy pot", is_available: true, retail_price: { price: 0.65, measure: "ea" } }] });
    if (method === "PUT") { writes++; return Response.json(null); }
    if (!writes) return Response.json(original);
    const result = results[readbacks++] ?? 200;
    if (result === "network") throw new Error("dummy-secret transport error");
    if (result === "schema") return Response.json({ secret: "dummy-secret invalid schema" });
    if (result === "timeout") return new Promise<Response>(() => {});
    if (result === "state") { const missingPrice = structuredClone(original); delete (missingPrice.items[0] as {subtotal_price?:number}).subtotal_price; return Response.json(missingPrice); }
    if (result === "mismatch") return Response.json(original);
    if (result !== 200) return Response.json({ secret: "dummy-secret server body" }, { status: result });
    return Response.json({ ...original, total_price: 0, items: [] });
  } });
  const context: PlanContext = { client, basketContext: { storeNumber: "0123", slotBooked: false }, productContext: { storeIdentifier: "0123" } };
  return { context, methods, get writes() { return writes; }, get readbacks() { return readbacks; } };
}
async function apply(results: ReadResult[]) {
  const f = fixture(results);
  const plan = await createBasketPlan(f.context, [{ sku: "7515858", quantity: 0 }], { maxTotal: 1.3, maxQuantity: 2 });
  return { f, result: applyBasketPlan(f.context, plan, plan.approval) };
}

describe("bounded post-write readback recovery", () => {
  for (const failure of [500, 502, 503, 504, "network"] as const) {
    it(`retries only the basket GET once after ${failure}, never the successful PUT`, async () => {
      const { f, result } = await apply([failure, 200]);
      const verified = await result;
      assert.equal(verified.ok, true);
      assert.equal(verified.verifiedChanges, 1);
      assert.equal(verified.basket.items.length, 0);
      assert.equal(f.writes, 1);
      assert.equal(f.readbacks, 2);
      assert.equal(f.methods.filter(method => method === "PUT").length, 1);
    });
  }

  it("returns unknown after one failed retry with only a fixed category and HTTP status", async () => {
    const { f, result } = await apply([500, 503, 200]);
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof BasketApplyError);
      assert.equal(error.outcome, "unknown");
      assert.deepEqual(error.readbackFailure, { category: "http", httpStatus: 503 });
      assert.doesNotMatch(JSON.stringify(error), /dummy-secret/);
      return true;
    });
    assert.equal(f.writes, 1);
    assert.equal(f.readbacks, 2);
  });

  it("does not retry schema validation, authentication or a definite basket mismatch", async () => {
    for (const failure of ["schema", 401, 400, 408, 501, "mismatch", "state"] as const) {
      const { f, result } = await apply([failure, 200]);
      await assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof BasketApplyError);
        assert.equal(error.outcome, failure === "mismatch" ? "mismatch" : "unknown");
        if (failure === "schema") assert.deepEqual(error.readbackFailure, { category: "validation", httpStatus: 200 });
        if (failure === 401) assert.deepEqual(error.readbackFailure, { category: "authentication", httpStatus: 401 });
        return true;
      });
      assert.equal(f.writes, 1);
      assert.equal(f.readbacks, 1);
    }
  });

  it("bounds repeated network failures to two reads and omits invented HTTP status", async () => {
    const { f, result } = await apply(["network", "network", 200]);
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof BasketApplyError);
      assert.deepEqual(error.readbackFailure, { category: "network" });
      return true;
    });
    assert.equal(f.writes, 1);
    assert.equal(f.readbacks, 2);
  });

  it("does not retry a request deadline or a local authentication persistence failure", async () => {
    const f = fixture(["timeout", 200]);
    const original = f.context.client.request.bind(f.context.client);
    f.context.client.request = (path, opts) => original(path, { ...opts, timeoutMs: 20 });
    const plan = await createBasketPlan(f.context, [{ sku: "7515858", quantity: 0 }], { maxTotal: 1.3, maxQuantity: 2 });
    await assert.rejects(applyBasketPlan(f.context, plan, plan.approval), (error: unknown) => {
      assert.ok(error instanceof BasketApplyError);
      assert.deepEqual(error.readbackFailure, { category: "timeout" });
      return true;
    });
    assert.equal(f.writes, 1);
    assert.equal(f.readbacks, 1);

    // The transport already tests private save failures; inject its exact fixed
    // error here to check that status0 is not blindly treated as a network retry.
    const local = fixture([200]);
    const request = local.context.client.request.bind(local.context.client);
    let failedReads = 0;
    local.context.client.request = async (path, opts) => {
      if (local.writes && (opts?.method ?? "GET") === "GET" && path.endsWith("/basket")) {
        failedReads++;
        throw new ApiError(0, "Updated authentication cookies could not be saved privately. Run local auth login before another operation.");
      }
      return request(path, opts);
    };
    const p = await createBasketPlan(local.context, [{ sku: "7515858", quantity: 0 }], { maxTotal: 1.3, maxQuantity: 2 });
    await assert.rejects(applyBasketPlan(local.context, p, p.approval), (error: unknown) => {
      assert.ok(error instanceof BasketApplyError);
      assert.deepEqual(error.readbackFailure, { category: "local_state" });
      return true;
    });
    assert.equal(local.writes, 1);
    assert.equal(failedReads, 1);
  });

  it("prints only allowlisted structured readback metadata in JSON", async () => {
    const originalArgs = process.argv;
    const originalWrite = process.stdout.write;
    let output = "";
    try {
      process.argv = [...process.argv, "--json"];
      process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
      const error = new BasketApplyError("Basket readback failed.", "unknown", 0, undefined, { category: "http", httpStatus: 500 });
      (error.readbackFailure as unknown as Record<string, unknown>).raw = "dummy-secret";
      printError(error);
    } finally { process.argv = originalArgs; process.stdout.write = originalWrite; }
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed.readbackFailure, { category: "http", httpStatus: 500 });
    assert.equal(parsed.outcome, "unknown");
    assert.doesNotMatch(output, /dummy-secret/);
  });

  it("SIGTERM during the retry delay reports an unknown write and never sends another GET", async () => {
    const planModule = pathToFileURL(resolve("src/basket/plan.ts")).href;
    const httpModule = pathToFileURL(resolve("src/client/http.ts")).href;
    const helpers = pathToFileURL(resolve("test/_helpers.ts")).href;
    const lifecycle = pathToFileURL(resolve("src/auth/lifecycle.ts")).href;
    const code = `
      import {createBasketPlan,applyBasketPlan} from ${JSON.stringify(planModule)};
      import {GroceriesClient,RETAILER_ORIGIN} from ${JSON.stringify(httpModule)};
      import {fakeSession} from ${JSON.stringify(helpers)};
      import {installInterruptionReporter} from ${JSON.stringify(lifecycle)};
      let writes=0,reads=0;
      installInterruptionReporter(result=>process.stdout.write(JSON.stringify({outcome:result.outcome,writes,reads})+'\\n'));
      const basket={basket_id:'basket-1',is_in_amend_mode:false,total_price:0.65,items:[{item_uid:'line-1',quantity:1,uom:'ea',subtotal_price:0.65,product:{sku:'7515858'}}]};
      const client=new GroceriesClient({session:fakeSession(),baseUrl:RETAILER_ORIGIN,fetchImpl:async(input,init)=>{
        const path=new URL(String(input)).pathname;
        if(path.endsWith('/status'))return new Response(null,{status:404});
        if(path.includes('product/v1/product'))return Response.json({products:[{product_uid:'7515858',name:'Dummy',retail_price:{price:0.65,measure:'ea'}}]});
        if(init?.method==='PUT'){writes++;return Response.json(null);}
        if(!writes)return Response.json(basket);
        reads++;
        setTimeout(()=>process.kill(process.pid,'SIGTERM'),40);
        return Response.json({},{status:500});
      }});
      const c={client,basketContext:{storeNumber:'0123',slotBooked:false},productContext:{storeIdentifier:'0123'}};
      const p=await createBasketPlan(c,[{sku:'7515858',quantity:0}],{maxTotal:1.3,maxQuantity:2});
      await applyBasketPlan(c,p,p.approval).catch(()=>{});
    `;
    const child = spawn(process.execPath, ["--import", resolve("test/isolate.mjs"), "--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    const status = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
    clearTimeout(timeout);
    assert.equal(status, 143, stderr);
    assert.deepEqual(JSON.parse(stdout), { outcome: "unknown", writes: 1, reads: 1 });
  });
});
