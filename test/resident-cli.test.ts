import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runResidentService } from '../src/auth/service.js';
import { residentStatus, stopResidentService } from '../src/client/resident-service.js';
import { saveSession } from '../src/auth/session.js';
import { fakeSession } from './_helpers.js';
import { AuthError } from '../src/client/http.js';

async function invoke(home: string, path: string, args: string[], expectedExit = 0) {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), '--json', ...args], {
    env: { PATH: process.env.PATH, HOME: home, SAINSBURYS_SESSION_PATH: path, SAINSBURYS_EMAIL: 'dummy@example.invalid', SAINSBURYS_AUTO_SIGN_IN: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
  const exit = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
  clearTimeout(timer);
  assert.equal(exit, expectedExit, stdout + stderr);
  assert.doesNotMatch(stdout + stderr, /test-jwt|AbCdEfGh|WC_AUTHENTICATION|abck-token/);
  return JSON.parse(stdout);
}

test('real CLI reuses one resident service across plans, readback and logout without another login', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sainsburys-resident-cli-'));
  const path = join(home, 'session.json');
  const session = fakeSession({ accountEmail: 'dummy@example.invalid', authGeneration: randomUUID(), browserManaged: true });
  await saveSession(path, session);
  let starts = 0, logins = 0, closes = 0, writes = 0;
  const basket: any = { basket_id: 'dummy-basket', is_in_amend_mode: false, total_price: 0, items: [] };
  const engine = {
    start: async () => { starts++; },
    login: async () => { logins++; throw new Error('An ordinary operation must never start interactive login'); },
    getSession: () => session,
    status: () => ({ authenticated: true, needsLogin: false }),
    diagnoseAuthentication: async () => ({authenticated:true,page:'retailer' as const,passwordFieldVisible:false,mfaFieldVisible:false,credentialPairsObserved:1,storedCredentialsAvailable:true,unexpectedSecret:'must-not-export'}),
    close: async () => { closes++; },
    request: async (input: { url: string; method: string; body?: string }) => {
      const url = new URL(input.url); let body: unknown;
      if (url.pathname.endsWith('/customer/profile')) body = { user_id: session.userId, email: session.accountEmail, store_number: '0123' };
      else if (url.pathname.endsWith('/slot/reservation') || url.pathname.endsWith('/order/status')) body = null;
      else if (url.pathname.endsWith('/order/123')) body = {order_uid:'123',status:'Delivered',total:2,order_items:[]};
      else if (url.pathname.endsWith('/order')) body = {orders:[{order_uid:'123',status:'Delivered',total:2}]};
      else if (url.pathname.endsWith('/product')) body = { products: [{ product_uid: '12345', name: 'Dummy pot', is_available: true, retail_price: { price: 2, measure: 'ea' } }] };
      else if (url.pathname.endsWith('/basket') || url.pathname.endsWith('/basket/item')) {
        if (input.method !== 'GET') {
          writes++;
          const request = JSON.parse(input.body!); const change = request.items?.[0] ?? request;
          basket.items = change.quantity ? [{ item_uid: 'dummy-line', quantity: change.quantity, uom: change.uom, selected_catchweight: change.selected_catchweight, product: { sku: '12345', name: 'Dummy pot' }, subtotal_price: change.quantity * 2 }] : [];
          basket.total_price = change.quantity * 2;
        }
        body = basket;
      } else throw new Error('Unexpected dummy endpoint');
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    },
  };
  const config = { email: session.accountEmail!, sessionPath: path, headed: true, baseUrl: 'https://www.sainsburys.co.uk', loginBaseUrl: 'https://account.sainsburys.co.uk' };
  const running = runResidentService(config, () => engine as any);
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { ready = (await residentStatus(path)).running; if (!ready) await new Promise(done => setTimeout(done, 20)); }
    assert.ok(ready, 'Dummy resident service became available');
    assert.equal((await invoke(home, path, ['basket', 'show'])).items.length, 0);
    assert.deepEqual(await invoke(home, path, ['auth', 'diagnose']),{authenticated:true,page:'retailer',passwordFieldVisible:false,mfaFieldVisible:false,credentialPairsObserved:1,storedCredentialsAvailable:true,
      // An older engine omits later fields; the client reports safe defaults.
      usernameFieldVisible:null,namedPasswordFieldVisible:null,autoSignIn:'unavailable',lastVerifiedAt:null,lastHeartbeatAt:null,lastHeartbeatOk:null,recentEvents:[]});
    assert.equal((await invoke(home, path, ['order', 'list', '--page-size', '5'])).orders[0].order_uid, '123');
    assert.deepEqual((await invoke(home, path, ['order', 'get', '123'])).order_items, []);
    assert.equal((await invoke(home, path, ['order', 'get', '123/amend'], 1)).ok, false);
    assert.equal((await invoke(home, path, ['order', 'list', '--page-size', '0'], 1)).ok, false);
    const targets = join(home, 'targets.json'), planPath = join(home, 'plan.json');
    await writeFile(targets, '[{"sku":"12345","quantity":1,"uom":"ea"}]', { mode: 0o600 });
    const plan = await invoke(home, path, ['basket', 'plan', targets, '--max-total', '4', '--max-quantity', '2', '--out', planPath]);
    const applied = await invoke(home, path, ['basket', 'apply', planPath, '--approve', plan.approval]);
    assert.equal(applied.verifiedChanges, 1);
    const again = await invoke(home, path, ['basket', 'apply', planPath, '--approve', plan.approval]);
    assert.equal(again.alreadyApplied, true);
    assert.equal(again.verifiedChanges, 0);
    const status = await invoke(home, path, ['auth', 'status']);
    assert.equal(status.browser.running, true);
    assert.equal(starts, 1); assert.equal(logins, 0); assert.equal(writes, 1); assert.equal(closes, 0);
    await invoke(home, path, ['auth', 'logout']);
    await running;
    assert.equal(closes, 1);
    assert.equal((await residentStatus(path)).running, false);
  } finally {
    await stopResidentService(path).catch(() => {});
    await running.catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test('explicit CLI login retains the browser, subsequent reads do not log in, and stop retains only the cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sainsburys-resident-login-cli-'));
  const path = join(home, 'session.json');
  const initial = fakeSession({ accountEmail: 'dummy@example.invalid', authGeneration: randomUUID(), browserManaged: true });
  await saveSession(path, initial);
  let active: typeof initial | undefined;
  let logins = 0, closes = 0;
  const engine = {
    start: async () => {},
    login: async () => {
      logins++;
      active = { ...initial, authGeneration: randomUUID(), browserManaged: true };
      await saveSession(path, active);
      return active;
    },
    getSession: () => active,
    status: () => ({ authenticated: !!active, needsLogin: !active }),
    close: async () => { closes++; },
    request: async (input: { url: string }) => {
      const url = new URL(input.url);
      const body = url.pathname.endsWith('/customer/profile') ? { user_id: initial.userId, email: initial.accountEmail, store_number: '0123' }
        : url.pathname.endsWith('/slot/reservation') ? null
        : { basket_id: 'dummy-basket', items: [], total_price: 0, is_in_amend_mode: false };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    },
  };
  const config = { email: initial.accountEmail!, sessionPath: path, headed: true, baseUrl: 'https://www.sainsburys.co.uk', loginBaseUrl: 'https://account.sainsburys.co.uk' };
  const running = runResidentService(config, () => engine as any);
  try {
    for (let i = 0; i < 100 && !(await residentStatus(path)).running; i++) await new Promise(done => setTimeout(done, 20));
    const loggedIn = await invoke(home, path, ['auth', 'login']);
    assert.equal(loggedIn.ok, true); assert.equal(loggedIn.user_id, initial.userId);
    assert.equal(logins, 1); assert.equal(closes, 0);
    for (let i = 0; i < 3; i++) assert.equal((await invoke(home, path, ['basket', 'show'])).items.length, 0);
    assert.equal(logins, 1); assert.equal(closes, 0);
    await invoke(home, path, ['auth', 'stop']); await running;
    assert.equal(closes, 1);
    const { loadSession } = await import('../src/auth/session.js');
    assert.equal((await loadSession(path))?.browserManaged, true);
    await invoke(home, path, ['auth', 'logout']);
    assert.equal(await loadSession(path), null);
  } finally {
    await stopResidentService(path).catch(() => {}); await running.catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});


test('a later CLI read recovers through the retained engine after an earlier silent recovery failed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sainsburys-resident-recovery-cli-'));
  const path = join(home, 'session.json');
  const session = fakeSession({ accountEmail: 'dummy@example.invalid', authGeneration: randomUUID(), browserManaged: true });
  await saveSession(path, session);
  let active = true, resumed = false, starts = 0, logins = 0, reads = 0;
  const engine = {
    start: async () => { starts++; },
    login: async () => { logins++; throw new Error('Unexpected interactive login'); },
    getSession: () => active ? session : undefined,
    getSessionBinding: () => ({ userId: session.userId, authGeneration: session.authGeneration }),
    status: () => ({ authenticated: active, needsLogin: !active }),
    close: async () => { active = false; },
    request: async (input: { url: string; method: string }) => {
      assert.equal(input.method, 'GET');
      assert.ok(input.url.endsWith('/customer/profile'));
      reads++;
      if (!resumed) { active = false; throw new AuthError(401); }
      active = true;
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: session.userId, email: session.accountEmail, store_number: '0123' }) };
    },
  };
  const config = { email: session.accountEmail!, sessionPath: path, headed: true, baseUrl: 'https://www.sainsburys.co.uk', loginBaseUrl: 'https://account.sainsburys.co.uk' };
  const running = runResidentService(config, () => engine);
  try {
    for (let i = 0; i < 100 && !(await residentStatus(path)).running; i++) await new Promise(done => setTimeout(done, 20));
    const failed = await invoke(home, path, ['customer', 'profile'], 2);
    assert.equal(failed.error.code, 'AuthError');
    assert.equal((await residentStatus(path)).authenticated, false);
    resumed = true;
    const profile = await invoke(home, path, ['customer', 'profile']);
    assert.equal(profile.user_id, session.userId);
    assert.equal(reads, 2); assert.equal(starts, 1); assert.equal(logins, 0);
  } finally {
    await stopResidentService(path).catch(() => {}); await running.catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});
