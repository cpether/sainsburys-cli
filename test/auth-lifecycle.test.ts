import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { clearSession, withAuthLock, saveSession, temporaryProfileRoot } from "../src/auth/session.js";
import { fakeSession } from "./_helpers.js";

const exec = promisify(execFile);
const sessionModule = pathToFileURL(resolve("src/auth/session.ts")).href;
const loginModule = pathToFileURL(resolve("src/auth/login.ts")).href;
const clientModule = pathToFileURL(resolve("src/client/http.ts")).href;
const cliModule = pathToFileURL(resolve("src/cli/index.ts")).href;
async function temporary<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sainsburys-lifecycle-test-"));
  try { return await fn(dir); } finally { await rm(dir, {recursive:true,force:true}); }
}
async function deadPid(): Promise<number> {
  const result = await exec(process.execPath,["-e","process.stdout.write(String(process.pid))"]);
  return Number(result.stdout);
}
function childLogin(sessionPath: string, persist: boolean, home: string, cli = false) {
  const code = `
    import {chromium} from 'playwright';
    import {EventEmitter} from 'node:events';
    import {writeFile} from 'node:fs/promises';
    import {performLogin} from ${JSON.stringify(loginModule)};
    let profile, rejectWait;
    chromium.launchPersistentContext=async directory=>{
      profile=directory;
      const page=Object.assign(new EventEmitter(),{
        async evaluate(){return 'DummyBrowser/1';},
        async goto(){process.stdout.write(JSON.stringify({profile,pid:process.pid})+'\\n');},
        async waitForURL(){await new Promise((_,reject)=>{rejectWait=reject;});},
      });
      return {newPage:async()=>page,close:async()=>{
        if(${cli})rejectWait?.(new Error('fake browser closed'));
        await new Promise(done=>setTimeout(done,30));
        await writeFile(process.env.AUTH_TEST_SESSION+'.closed','closed');
      }};
    };
    if(${cli}){
      process.argv=[process.execPath,${JSON.stringify(resolve("src/cli/index.ts"))},'--json','auth','login',...(${persist}?[]:['--no-persist'])];
      await import(${JSON.stringify(cliModule)});
    }else{
      await performLogin({persist:${persist},config:{email:'dummy@example.com',sessionPath:process.env.AUTH_TEST_SESSION,headed:true,baseUrl:'https://www.sainsburys.co.uk',loginBaseUrl:'https://account.sainsburys.co.uk'}});
    }
  `;
  const child = spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{
    cwd:resolve("."),env:{...process.env,HOME:home,AUTH_TEST_SESSION:sessionPath,SAINSBURYS_SESSION_PATH:sessionPath,SAINSBURYS_EMAIL:"dummy@example.com"},stdio:["ignore","pipe","pipe"],
  });
  let stderr = "";
  child.stderr.on("data",chunk=>{stderr+=String(chunk);});
  const exit = new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{
    child.once("error",reject);child.once("exit",(code,signal)=>done({code,signal}));
  });
  const ready = new Promise<{profile:string;pid:number}>((done,reject)=>{
    let buffer="";
    const timer=setTimeout(()=>reject(new Error(`Child login did not become ready: ${stderr}`)),10_000);
    child.stdout.on("data",chunk=>{buffer+=String(chunk);if(buffer.includes("\n")){clearTimeout(timer);done(JSON.parse(buffer.split("\n")[0]!));}});
    child.once("exit",()=>{clearTimeout(timer);reject(new Error(`Child login exited early: ${stderr}`));});
  });
  return {child,ready,exit,get stderr(){return stderr;}};
}

describe("recoverable local locks",()=>{
  it("reclaims dead legacy PID files and dead directory claims but respects live owners",()=>temporary(async dir=>{
    const path=join(dir,"basket.lock");const dead=await deadPid();
    await writeFile(path,String(dead),{mode:0o600});
    await withAuthLock(path,async()=>{assert.equal((await stat(path)).isDirectory(),true);});
    await mkdir(path,{mode:0o700});
    await writeFile(join(path,`${dead}-${randomUUID()}.owner`),String(dead),{mode:0o600});
    await withAuthLock(path,async()=>{});
    await mkdir(path,{mode:0o700}); // interrupted release leaves an empty directory
    await withAuthLock(path,async()=>{});
    await writeFile(path,String(process.pid),{mode:0o600});
    await assert.rejects(withAuthLock(path,async()=>{},10),/Local state lock is busy/);
    assert.equal(await readFile(path,"utf8"),String(process.pid));
  }));

  it("competing processes reclaim one stale lock without overlapping critical sections",()=>temporary(async dir=>{
    const lock=join(dir,"basket.lock");const dead=await deadPid();
    await mkdir(lock,{mode:0o700});
    await writeFile(join(lock,`${dead}-${randomUUID()}.owner`),String(dead),{mode:0o600});
    const critical=join(dir,"critical");const visits=join(dir,"visits");
    const code=`
      import {withAuthLock} from ${JSON.stringify(sessionModule)};
      import {open,rm,appendFile} from 'node:fs/promises';
      await withAuthLock(process.env.AUTH_TEST_LOCK,async()=>{
        const file=await open(process.env.AUTH_TEST_CRITICAL,'wx',0o600);
        await appendFile(process.env.AUTH_TEST_VISITS,String(process.pid)+'\\n');
        await new Promise(done=>setTimeout(done,15));
        await file.close();await rm(process.env.AUTH_TEST_CRITICAL);
      });
    `;
    await Promise.all(Array.from({length:6},()=>exec(process.execPath,["--import","tsx","--input-type=module","-e",code],{
      cwd:resolve("."),env:{...process.env,HOME:dir,AUTH_TEST_LOCK:lock,AUTH_TEST_CRITICAL:critical,AUTH_TEST_VISITS:visits},
    })));
    assert.equal((await readFile(visits,"utf8")).trim().split("\n").length,6);
    await assert.rejects(stat(lock),{code:"ENOENT"});
    assert.deepEqual((await readdir(dir)).filter(name=>name.includes("candidate")),[]);
  }));
});

describe("interrupted manual login lifecycle",()=>{
  for(const signal of ["SIGINT","SIGTERM"] as const){
    for(const persist of [true,false]){
      it(`${signal} closes the fake browser, removes temporary state, and releases ${persist?"persistent":"temporary"} login resources`,()=>temporary(async dir=>{
        const session=join(dir,"session.json");const child=childLogin(session,persist,dir);
        try{
          const {profile}=await child.ready;
          assert.ok(await stat(profile));
          child.child.kill(signal);
          assert.deepEqual(await child.exit,{code:signal==="SIGINT"?130:143,signal:null},child.stderr);
          assert.equal(await readFile(`${session}.closed`,"utf8"),"closed");
          await assert.rejects(stat(`${session}.profile.lock`),{code:"ENOENT"});
          if(!persist)await assert.rejects(stat(profile),{code:"ENOENT"});
          await clearSession(session);
        }finally{child.child.kill("SIGKILL");await child.exit;await clearSession(session);}
      }));
    }
  }

  for(const signal of ["SIGINT","SIGTERM"] as const){
    it(`actual CLI ${signal} waits for asynchronous browser cleanup before exiting`,()=>temporary(async dir=>{
      const session=join(dir,"session.json");const child=childLogin(session,false,dir,true);
      try{
        const {profile}=await child.ready;
        child.child.kill(signal);
        assert.deepEqual(await child.exit,{code:signal==="SIGINT"?130:143,signal:null},child.stderr);
        assert.equal(await readFile(`${session}.closed`,"utf8"),"closed");
        await assert.rejects(stat(profile),{code:"ENOENT"});
      }finally{child.child.kill("SIGKILL");await child.exit;await clearSession(session);}
    }));
  }

  it("SIGTERM aborts an in-flight mocked retailer request before releasing its basket lock",()=>temporary(async dir=>{
    const lock=join(dir,"basket.lock"),marker=join(dir,"request-aborted");
    const code=`
      import {withAuthLock} from ${JSON.stringify(sessionModule)};
      import {GroceriesClient} from ${JSON.stringify(clientModule)};
      import {writeFileSync} from 'node:fs';
      const client=new GroceriesClient({session:${JSON.stringify(fakeSession())},baseUrl:'https://www.sainsburys.co.uk',fetchImpl:async(_,init)=>{
        process.stdout.write('ready\\n');
        return await new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{
          writeFileSync(process.env.AUTH_TEST_MARKER,'aborted');reject(new Error('request cancelled'));
        },{once:true}));
      }});
      await withAuthLock(process.env.AUTH_TEST_LOCK,async()=>client.request('/groceries-api/gol-services/basket/v2/basket',{method:'PUT',body:{items:[]},allowEmpty:true})).catch(()=>{process.exitCode=1;});
    `;
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:resolve("."),env:{...process.env,HOME:dir,AUTH_TEST_LOCK:lock,AUTH_TEST_MARKER:marker},stdio:["ignore","pipe","pipe"]});
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>done({code,signal}));});
    try{
      await new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(new Error('Request child did not start')),10_000);child.stdout.once("data",()=>{clearTimeout(timer);done();});});
      child.kill("SIGTERM");assert.deepEqual(await exited,{code:143,signal:null});
      assert.equal(await readFile(marker,"utf8"),"aborted");
      await assert.rejects(stat(lock),{code:"ENOENT"});
    }finally{child.kill("SIGKILL");await exited;}
  }));

  it("logout recovers SIGKILL's dead profile lock, abandoned no-persist profile and atomic session files",()=>temporary(async dir=>{
    const session=join(dir,"session.json");
    await saveSession(session,fakeSession());
    let child=childLogin(session,true,dir);
    await child.ready;child.child.kill("SIGKILL");await child.exit;
    assert.ok(await stat(`${session}.profile.lock`));
    await clearSession(session);
    await assert.rejects(stat(`${session}.profile.lock`),{code:"ENOENT"});
    child=childLogin(session,false,dir);
    const {profile}=await child.ready;child.child.kill("SIGKILL");await child.exit;
    assert.ok(await stat(profile));
    await writeFile(join(profile,"dummy-cookie"),"dummy-secret",{mode:0o600});
    const partial=`${session}.${randomUUID()}.tmp`;
    await writeFile(partial,"dummy-token",{mode:0o600});
    await clearSession(session);
    await assert.rejects(stat(profile),{code:"ENOENT"});
    await assert.rejects(stat(temporaryProfileRoot(session)),{code:"ENOENT"});
    await assert.rejects(stat(partial),{code:"ENOENT"});
  }));

  it("logout refuses to remove another live temporary profile and clears known default legacy profiles",()=>temporary(async dir=>{
    const custom=join(dir,"session.json");const child=childLogin(custom,false,dir);
    try{
      const {profile}=await child.ready;
      await assert.rejects(clearSession(custom),/temporary login is still active/);
      assert.ok(await stat(profile));
    }finally{child.child.kill("SIGTERM");await child.exit;await clearSession(custom);}
    const defaultDir=join(dir,".config","sainsburys");
    await mkdir(join(defaultDir,"browser-data"),{recursive:true,mode:0o700});
    await writeFile(join(defaultDir,"browser-data","dummy-cookie"),"dummy-secret",{mode:0o600});
    await exec(process.execPath,["--import","tsx","--input-type=module","-e",`import {clearSession} from ${JSON.stringify(sessionModule)};await clearSession(process.env.AUTH_TEST_SESSION);`],{
      cwd:resolve("."),env:{...process.env,HOME:dir,AUTH_TEST_SESSION:join(defaultDir,"session.json")},
    });
    await assert.rejects(stat(join(defaultDir,"browser-data")),{code:"ENOENT"});
  }));
});
