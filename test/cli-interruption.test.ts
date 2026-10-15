import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeSession } from "./_helpers.js";

const exec = promisify(execFile);
const cliPath = resolve("src/cli/index.ts");
const cliModule = pathToFileURL(cliPath).href;
const preloadPath = resolve("test/cli-preload.mjs");
const preloadModule = pathToFileURL(preloadPath).href;
const httpModule = pathToFileURL(resolve("src/client/http.ts")).href;
const lifecycleModule = pathToFileURL(resolve("src/auth/lifecycle.ts")).href;

async function interruptedCli(signal: "SIGINT" | "SIGTERM", mode: "write" | "readback" | "read" | "queued") {
  const home = await mkdtemp(join(tmpdir(), "sainsburys-cli-interruption-"));
  const session = join(home,"session.json"), state = join(home,"basket.json"), log = join(home,"requests.jsonl");
  const targets = join(home,"targets.json"), plan = join(home,"plan.json"), aborted = join(home,"aborted");
  const env = {PATH:process.env.PATH,HOME:home,SAINSBURYS_EMAIL:"dummy@example.invalid",SAINSBURYS_SESSION_PATH:session,
    TEST_BASKET_STATE:state,TEST_REQUEST_LOG:log,TEST_ABORT_MARKER:aborted};
  try {
    await writeFile(session,JSON.stringify(fakeSession({accountEmail:"dummy@example.invalid"})),{mode:0o600});
    await writeFile(state,JSON.stringify({basket_id:"basket-1",is_in_amend_mode:false,total_price:2,item_count:1,items:[
      {item_uid:"line-1",quantity:1,uom:"ea",selected_catchweight:"",subtotal_price:2,product:{sku:"12345",name:"Dummy product"}},
    ]}),{mode:0o600});
    await writeFile(targets,JSON.stringify([{sku:"12345",quantity:2,uom:"ea"}]),{mode:0o600});
    await writeFile(log,"");
    const planned = await exec(process.execPath,["--import","tsx","--import",preloadPath,cliPath,"--json","basket","plan",targets,"--max-total","10","--max-quantity","3","--out",plan],{env,cwd:resolve(".")});
    const approval = JSON.parse(planned.stdout).approval;
    await writeFile(log,"");
    const args = mode === "read" ? ["--json","basket","show"] : ["--json","basket","apply",plan,"--approve",approval];
    const code = `
      import {writeFileSync} from 'node:fs';
      await import(${JSON.stringify(preloadModule)});
      const fetchMock=globalThis.fetch;
      let wrote=false;
      const waitForSignal=init=>{
        process.send({ready:true});
        return new Promise((_,reject)=>{
          // The injected pre-transport queue also models the HTTP deadline's
          // live timer, so this child cannot exit before its parent signals it.
          const deadline=${JSON.stringify(mode)}==='queued'?setTimeout(()=>reject(new Error('dummy queue deadline')),30000):undefined;
          init.signal.addEventListener('abort',()=>{
            if(deadline)clearTimeout(deadline);
            writeFileSync(process.env.TEST_ABORT_MARKER,'aborted');reject(new Error('dummy cancellation'));
          },{once:true});
        });
      };
      if(${JSON.stringify(mode)}==='queued'){
        const {GroceriesClient}=await import(${JSON.stringify(httpModule)});
        const {interruptionSignal}=await import(${JSON.stringify(lifecycleModule)});
        const request=GroceriesClient.prototype.request;
        // Hold the actual plan's HTTP call before transport starts. The HTTP
        // queue tests cover the lock itself; this covers the outer CLI scope.
        GroceriesClient.prototype.request=function(path,opts){
          if(opts?.method==='PUT')return waitForSignal({signal:interruptionSignal()});
          return request.call(this,path,opts);
        };
      }
      globalThis.fetch=async(input,init)=>{
        const url=new URL(String(input));
        const isBasket=url.pathname.endsWith('/basket') || url.pathname.endsWith('/basket/item');
        const isWrite=!!init.method && init.method!=='GET';
        if(isBasket && isWrite){
          if(${JSON.stringify(mode)}==='write')return waitForSignal(init);
          const response=await fetchMock(input,init);wrote=true;return response;
        }
        if(isBasket && !isWrite && (${JSON.stringify(mode)}==='read' || wrote))return waitForSignal(init);
        return fetchMock(input,init);
      };
      process.argv=[process.execPath,${JSON.stringify(cliPath)},...${JSON.stringify(args)}];
      await import(${JSON.stringify(cliModule)});
    `;
    const child = spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{env,cwd:resolve("."),stdio:["ignore","pipe","pipe","ipc"]});
    let stdout = "", stderr = "";
    child.stdout.on("data",chunk=>{stdout+=String(chunk);});
    child.stderr.on("data",chunk=>{stderr+=String(chunk);});
    const exited = new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{
      child.once("error",reject);child.once("exit",(code,signal)=>done({code,signal}));
    });
    try {
      await new Promise<void>((done,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`CLI did not reach interrupted request: ${stderr}${stdout}`)),10_000);
        child.once("message",()=>{clearTimeout(timer);done();});
        child.once("exit",()=>{clearTimeout(timer);reject(new Error(`CLI exited before the request: ${stderr}${stdout}`));});
      });
      child.kill(signal);
      assert.deepEqual(await exited,{code:signal==="SIGINT"?130:143,signal:null},stderr+stdout);
      const result = JSON.parse(stdout.trim()); // Also rejects multiple JSON results.
      assert.equal(result.ok,false);
      assert.equal(result.error.code,"InterruptedError");
      assert.equal(result.outcome,mode==="read"||mode==="queued"?"cancelled":"unknown");
      assert.doesNotMatch(stdout+stderr,/test-jwt|wcauthtoken|abc%2B|dummy cancellation/);
      assert.equal(await readFile(aborted,"utf8"),"aborted");
      const calls=(await readFile(log,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
      const writes=calls.filter(call=>call.method!=="GET");
      assert.equal(writes.length,mode==="readback"?1:0);
    } finally {child.kill("SIGKILL");await exited;}
  } finally {await rm(home,{recursive:true,force:true});}
}

describe("structured CLI interruptions",()=>{
  for(const signal of ["SIGINT","SIGTERM"] as const){
    it(`${signal} emits one unknown result during a basket PUT`,()=>interruptedCli(signal,"write"));
    it(`${signal} emits one unknown result between a completed write and its readback`,()=>interruptedCli(signal,"readback"));
    it(`${signal} emits one cancelled result during a read-only command`,()=>interruptedCli(signal,"read"));
    it(`${signal} emits one cancelled result while a mutation is queued before transport`,()=>interruptedCli(signal,"queued"));
  }
});
