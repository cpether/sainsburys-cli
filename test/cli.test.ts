import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeSession } from "./_helpers.js";

function run(args:string[], options:{session?:boolean;html?:boolean;store?:string}={}) {
  const home=mkdtempSync(join(tmpdir(),"sainsburys-cli-test-"));
  const session=join(home,"session.json"),log=join(home,"requests.jsonl");
  if(options.session)writeFileSync(session,JSON.stringify(fakeSession({accountEmail:"dummy@example.invalid"})),{mode:0o600});
  writeFileSync(log,"");
  const result=spawnSync(process.execPath,["--import","tsx","--import",resolve("test/cli-preload.mjs"),resolve("src/cli/index.ts"),...args],{
    encoding:"utf8",timeout:5000,cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:home,SAINSBURYS_SESSION_PATH:session,SAINSBURYS_EMAIL:"dummy@example.invalid",TEST_REQUEST_LOG:log,...(options.store?{SAINSBURYS_STORE_NUMBER:options.store}:{}),...(options.html?{TEST_RESPONSE:"html"}:{})},
  });
  const requests=readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  rmSync(home,{recursive:true,force:true});return {...result,requests};
}
test("help exposes only supported commands and prints version",()=>{
  const r=run(["--help"]);assert.equal(r.status,0);for(const cmd of ["auth","basket","order","product","customer","slot"])assert.match(r.stdout,new RegExp(cmd));assert.doesNotMatch(r.stdout,/\n  checkout/);
  assert.match(run(["--version"]).stdout,/^\d+\.\d+\.\d+\s*$/);
  const b=run(["basket","--help"]);for(const s of ["show","plan","apply"])assert.match(b.stdout,new RegExp(s));
});
test("payment, amendments and booking commands reject before any network",()=>{
  for(const args of [["checkout","--yes"],["payment"],["order","amend","123"],["slot","book","key","2099-01-01"],["basket","add","123"],["basket","set","123","2"]]){
    const r=run(["--json",...args],{session:true});assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).ok,false);assert.deepEqual(r.requests,[]);
  }
});
test("missing session gives authentication exit and one JSON result without secrets",()=>{
  const r=run(["--json","basket","show"]);assert.equal(r.status,2);const v=JSON.parse(r.stdout);assert.equal(v.ok,false);assert.doesNotMatch(r.stdout+r.stderr,/test-jwt|wcauthtoken|dummy-cookie|abc%2B/);
});
test("JSON basket and search execute actual implementation against mocked retailer",()=>{
  let r=run(["--json","basket","show"],{session:true});assert.equal(r.status,0,r.stdout+r.stderr);const basket=JSON.parse(r.stdout);assert.ok(basket.items??basket.basket?.items);assert.equal(r.stderr,"");
  r=run(["--json","product","search","dummy"],{session:true});assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).products[0].product_uid,"12345");
});
test("explicit environment store overrides account context",()=>{
  const r=run(["--json","customer","context"],{session:true,store:"9876"});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(JSON.parse(r.stdout).basketContext.storeNumber,"9876");
});
test("HTML challenge exits nonzero with structured redacted error",()=>{
  const r=run(["--json","basket","show"],{session:true,html:true});assert.equal(r.status,3);assert.equal(JSON.parse(r.stdout).ok,false);assert.doesNotMatch(r.stdout+r.stderr,/secret challenge|<html>/);
});

test("CLI creates private plans, applies once, and emits structured mismatch outcomes",()=>{
  const home=mkdtempSync(join(tmpdir(),"sainsburys-cli-workflow-"));
  const session=join(home,"session.json"),state=join(home,"basket.json"),log=join(home,"requests.jsonl"),targets=join(home,"targets.json"),planPath=join(home,"plan.json");
  writeFileSync(session,JSON.stringify(fakeSession({accountEmail:"dummy@example.invalid"})),{mode:0o600});
  writeFileSync(state,JSON.stringify({basket_id:"basket-1",is_in_amend_mode:false,total_price:0,items:[]}),{mode:0o600});
  writeFileSync(targets,JSON.stringify([{sku:"12345",quantity:1,uom:"ea"}]),{mode:0o600});writeFileSync(log,"");
  const invoke=(args:string[],mode="")=>spawnSync(process.execPath,["--import","tsx","--import",resolve("test/cli-preload.mjs"),resolve("src/cli/index.ts"),"--json",...args],{encoding:"utf8",timeout:5000,env:{PATH:process.env.PATH,HOME:home,SAINSBURYS_SESSION_PATH:session,SAINSBURYS_EMAIL:"dummy@example.invalid",TEST_BASKET_STATE:state,TEST_REQUEST_LOG:log,TEST_WRITE_MODE:mode}});
  try{
    const planned=invoke(["basket","plan",targets,"--max-total","10","--max-quantity","2","--out",planPath]);assert.equal(planned.status,0,planned.stdout+planned.stderr);
    const plan=JSON.parse(planned.stdout);assert.equal(plan.estimatedTotal,2);
    const applied=invoke(["basket","apply",planPath,"--approve",plan.approval]);assert.equal(applied.status,0,applied.stdout+applied.stderr);assert.equal(JSON.parse(applied.stdout).verifiedChanges,1);
    const again=invoke(["basket","apply",planPath,"--approve",plan.approval]);assert.equal(again.status,0,again.stdout+again.stderr);assert.equal(JSON.parse(again.stdout).alreadyApplied,true);
    let writes=readFileSync(log,"utf8").trim().split("\n").map(JSON.parse).filter(r=>r.method!=="GET");assert.equal(writes.length,1);
    const targets2=join(home,"targets2.json"),plan2=join(home,"plan2.json");writeFileSync(targets2,JSON.stringify([{sku:"12345",quantity:2,uom:"ea"}]));
    const planned2=invoke(["basket","plan",targets2,"--max-total","10","--max-quantity","2","--out",plan2]);assert.equal(planned2.status,0,planned2.stdout+planned2.stderr);
    const mismatch=invoke(["basket","apply",plan2,"--approve",JSON.parse(planned2.stdout).approval],"mismatch");assert.equal(mismatch.status,5,mismatch.stdout+mismatch.stderr);assert.equal(JSON.parse(mismatch.stdout).outcome,"mismatch");
  }finally{rmSync(home,{recursive:true,force:true});}
});

test("invalid CLI plan quantity fails before account or retailer requests",()=>{
  const home=mkdtempSync(join(tmpdir(),"sainsburys-cli-invalid-"));
  try{
    const targets=join(home,"targets.json"),log=join(home,"requests.jsonl");writeFileSync(targets,'[{"sku":"12345","quantity":-1}]');writeFileSync(log,"");
    const r=spawnSync(process.execPath,["--import","tsx","--import",resolve("test/cli-preload.mjs"),resolve("src/cli/index.ts"),"--json","basket","plan",targets,"--max-total","10","--max-quantity","2","--out",join(home,"plan.json")],{encoding:"utf8",timeout:5000,env:{PATH:process.env.PATH,HOME:home,SAINSBURYS_SESSION_PATH:join(home,"none"),TEST_REQUEST_LOG:log}});
    assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).ok,false);assert.equal(readFileSync(log,"utf8"),"");
  }finally{rmSync(home,{recursive:true,force:true});}
});

test("working-directory dotenv files cannot redirect the store or session",()=>{
  const home=mkdtempSync(join(tmpdir(),"sainsburys-cli-cwd-"));
  try {
    const session=join(home,"session.json");
    writeFileSync(session,JSON.stringify(fakeSession({accountEmail:"dummy@example.invalid"})),{mode:0o600});
    writeFileSync(join(home,".env"),'SAINSBURYS_STORE_NUMBER=9999\n');
    const r=spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),"--import",resolve("test/cli-preload.mjs"),resolve("src/cli/index.ts"),"--json","customer","context"],{encoding:"utf8",timeout:5000,cwd:home,env:{PATH:process.env.PATH,HOME:home,SAINSBURYS_EMAIL:"dummy@example.invalid",SAINSBURYS_SESSION_PATH:session}});
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.equal(JSON.parse(r.stdout).basketContext.storeNumber,"0123");
  } finally {rmSync(home,{recursive:true,force:true});}
});
