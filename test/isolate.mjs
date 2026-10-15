// Loaded before application modules in every automated test process.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home=mkdtempSync(join(tmpdir(),'sainsburys-test-home-'));
for(const key of Object.keys(process.env))if(key.startsWith('SAINSBURYS_'))delete process.env[key];
process.env.HOME=home;
process.env.USERPROFILE=home;
process.env.SAINSBURYS_SESSION_PATH=join(home,'state','session.json');
globalThis.fetch=async()=>{throw new Error('Real network access is disabled in automated tests');};
process.on('exit',()=>rmSync(home,{recursive:true,force:true}));
