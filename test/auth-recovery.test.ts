import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSession, loadSession, saveSession, temporaryProfileRoot, withAuthLock } from "../src/auth/session.js";
import { browserDataDir } from "../src/auth/browser.js";
import { fakeSession } from "./_helpers.js";
const deadPid = 2147483647;
const uuid = "00000000-0000-4000-8000-000000000001";

test("logout clears owned state and dead temporary profiles even while another temporary login is active", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"shopping-logout-partial-"));
  const path=join(dir,"session.json"),root=temporaryProfileRoot(path);
  const active=join(root,`${process.pid}-${uuid}`),dead=join(root,`${deadPid}-${uuid}`);
  try {
    await saveSession(path,fakeSession());
    const profile=browserDataDir(path,"dummy@example.invalid");await mkdir(profile,{recursive:true,mode:0o700});
    await mkdir(active,{recursive:true,mode:0o700});await mkdir(dead,{mode:0o700});
    await writeFile(join(active,"marker"),"keep",{mode:0o600});
    const partial=`${path}.${uuid}.tmp`;await writeFile(partial,"dummy session",{mode:0o600});
    await assert.rejects(clearSession(path),/temporary login/i);
    assert.equal(await loadSession(path),null);
    await assert.rejects(stat(profile),{code:"ENOENT"});
    await assert.rejects(stat(partial),{code:"ENOENT"});
    await assert.rejects(stat(dead),{code:"ENOENT"});
    assert.equal(await readFile(join(active,"marker"),"utf8"),"keep");
  }finally{await rm(root,{recursive:true,force:true});await rm(dir,{recursive:true,force:true});}
});

test("lock acquisition and logout remove abandoned candidates without touching live or unknown candidates",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"shopping-candidate-cleanup-"));const path=join(dir,"session.json");
  const lock=`${path}.lock`;
  const abandoned=`${lock}.${deadPid}-${uuid}.owner.candidate`;
  const alive=`${lock}.${process.pid}-${uuid}.owner.candidate`;
  const unknown=`${lock}.unrecognized.candidate`;
  try {
    await mkdir(abandoned,{mode:0o700});await mkdir(alive,{mode:0o700});await mkdir(unknown,{mode:0o700});
    await withAuthLock(lock,async()=>{});
    await assert.rejects(stat(abandoned),{code:"ENOENT"});assert.ok(await stat(alive));assert.ok(await stat(unknown));
    const profileCandidate=`${path}.profile.lock.${deadPid}-${uuid}.owner.candidate`;
    await mkdir(profileCandidate,{mode:0o700});
    await clearSession(path);await assert.rejects(stat(profileCandidate),{code:"ENOENT"});
    assert.ok(await stat(alive));assert.ok(await stat(unknown));
  }finally{await rm(dir,{recursive:true,force:true});}
});
