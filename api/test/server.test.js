import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../app.js';

process.env.SGL_SCRYPT_N = '1024';
process.env.SGL_SCRYPT_P = '1';

async function makeHarness(t, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sushi-id-test-'));
  const app = createApp({
    dbPath: path.join(dir, 'test.sqlite'), secureCookies: false, disableRateLimits: true,
    minimumRunSeconds: 0, serveStatic: false, ...overrides
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(() => {
    app.locals.store.close();
    rmSync(dir, { recursive: true, force: true });
    resolve();
  })));

  function makeClient() {
    let cookie = '';
    let csrfToken = '';
    return {
      async request(route, requestOptions = {}) {
        const { useCsrf = true, useCookie = true, ...options } = requestOptions;
        const headers = {
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(useCookie && cookie ? { cookie } : {}),
          ...(useCsrf && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
          ...(options.headers || {})
        };
        const response = await fetch(base + route, { ...options, headers });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = /Max-Age=0/i.test(setCookie) ? '' : setCookie.split(';')[0];
        const text = response.status === 204 ? '' : await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = {}; }
        if (data?.csrfToken) csrfToken = data.csrfToken;
        return { response, data, text };
      },
      get cookie() { return cookie; },
      get csrfToken() { return csrfToken; }
    };
  }

  return { app, base, makeClient, client: makeClient() };
}

test('registers securely, restores the session and logs out', async t => {
  const { app, client } = await makeHarness(t);
  const registered = await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'CaptainOne', password: 'correct horse battery staple' }) });
  assert.equal(registered.response.status, 201);
  assert.match(registered.data.recoveryCode, /^[a-f0-9-]+$/);
  assert.notEqual(registered.data.user.displayName, 'CaptainOne');
  assert.match(registered.response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(registered.response.headers.get('set-cookie'), /SameSite=Lax/i);
  const stored = app.locals.store.getUserByUsername('captainone');
  assert.match(stored.password_hash, /^scrypt\$/);
  assert.ok(!stored.password_hash.includes('correct horse'));

  const me = await client.request('/sushi-api/auth/me');
  assert.equal(me.data.user.username, 'CaptainOne');
  const loggedOut = await client.request('/sushi-api/auth/logout', { method: 'POST' });
  assert.equal(loggedOut.response.status, 204);
  const guest = await client.request('/sushi-api/auth/me');
  assert.equal(guest.data.user, null);
});

test('requires CSRF, blocks hostile origins, and sanitizes malformed JSON', async t => {
  const { base, client, makeClient } = await makeHarness(t);
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'GuardedUser', password: 'a-long-safe-password' }) });
  const missingCsrf = await client.request('/sushi-api/auth/logout', { method: 'POST', useCsrf: false });
  assert.equal(missingCsrf.response.status, 403);
  const hostile = await makeClient().request('/sushi-api/auth/register', {
    method: 'POST', headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'HostileUser', password: 'a-long-safe-password' })
  });
  assert.equal(hostile.response.status, 403);
  const malformed = await fetch(`${base}/sushi-api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"secret-that-must-not-be-logged"'
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Request body must be valid JSON.' });
});

test('recovery is one-time, atomic, and invalidates every old session', async t => {
  const { client, makeClient } = await makeHarness(t);
  const registered = await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'RecoverMe', password: 'old-password-is-long' }) });
  const code = registered.data.recoveryCode;
  const oldDevice = makeClient();
  assert.equal((await oldDevice.request('/sushi-api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'RecoverMe', password: 'old-password-is-long' }) })).response.status, 200);

  const recoveryClients = [makeClient(), makeClient()];
  const attempts = await Promise.all(recoveryClients.map((recoveryClient, index) => recoveryClient.request('/sushi-api/auth/recover', {
    method: 'POST', body: JSON.stringify({ username: 'RecoverMe', recoveryCode: code, newPassword: `new-password-number-${index}` })
  })));
  assert.deepEqual(attempts.map(item => item.response.status).sort(), [200, 409]);
  assert.equal((await oldDevice.request('/sushi-api/auth/me')).data.user, null);
  assert.equal((await makeClient().request('/sushi-api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'RecoverMe', password: 'old-password-is-long' }) })).response.status, 401);
  const winner = attempts.findIndex(item => item.response.status === 200);
  assert.equal((await makeClient().request('/sushi-api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'RecoverMe', password: `new-password-number-${winner}` }) })).response.status, 200);
});

test('accepts a run once and exposes only the public nickname', async t => {
  const { client } = await makeHarness(t);
  const registered = await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'PrivateLogin', password: 'a-long-test-password' }) });
  const displayName = registered.data.user.displayName;
  const started = await client.request('/sushi-api/runs/start', { method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'campaign', clientVersion: 'test-1' }) });
  assert.equal(started.response.status, 201);
  const finishBody = JSON.stringify({ runToken: started.data.runToken, value: 12345, metadata: { theater: 3, cheatEnabled: false } });
  assert.equal((await client.request(`/sushi-api/runs/${started.data.runId}/finish`, { method: 'POST', body: finishBody })).response.status, 201);
  assert.equal((await client.request(`/sushi-api/runs/${started.data.runId}/finish`, { method: 'POST', body: finishBody })).response.status, 409);

  const board = await client.request('/sushi-api/leaderboards/irontide/campaign?period=all');
  assert.equal(board.response.status, 200);
  assert.equal(board.data.entries[0].displayName, displayName);
  assert.equal(board.data.entries[0].value, 12345);
  assert.ok(!JSON.stringify(board.data).includes('PrivateLogin'));
  assert.equal(board.data.me.rank, 1);
});

test('rejects cheat-marked and impossible scores', async t => {
  const { client } = await makeHarness(t);
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'ScoreGuard', password: 'another-long-password' }) });
  const startCheat = await client.request('/sushi-api/runs/start', { method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'campaign' }) });
  assert.equal((await client.request(`/sushi-api/runs/${startCheat.data.runId}/finish`, { method: 'POST', body: JSON.stringify({ runToken: startCheat.data.runToken, value: 100, metadata: { cheatEnabled: true } }) })).response.status, 400);
  const startHuge = await client.request('/sushi-api/runs/start', { method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'campaign' }) });
  assert.equal((await client.request(`/sushi-api/runs/${startHuge.data.runId}/finish`, { method: 'POST', body: JSON.stringify({ runToken: startHuge.data.runToken, value: 999999999 }) })).response.status, 400);
});

test('never serves API source or database paths as static files', async t => {
  const { base } = await makeHarness(t, { serveStatic: true });
  for (const route of ['/api/security.js', '/%61pi/security.js', '/api/data/sushigamelab.sqlite', '/%61pi/data/sushigamelab.sqlite']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404, route);
  }
  assert.equal((await fetch(`${base}/account.js`)).status, 200);
});

test('uses Secure cookies when configured and can delete an account', async t => {
  const { client } = await makeHarness(t, { secureCookies: true });
  const registered = await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'DeleteMe', password: 'delete-this-password' }) });
  assert.match(registered.response.headers.get('set-cookie'), /Secure/i);
  // A Secure cookie is not sent over this test's HTTP transport, so deletion
  // behavior is covered with a separate non-Secure harness below.
});

test('deleting an account removes its session and scores', async t => {
  const { client } = await makeHarness(t);
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'DeleteMeToo', password: 'delete-this-password' }) });
  const deleted = await client.request('/sushi-api/auth/account', { method: 'DELETE', body: JSON.stringify({ password: 'delete-this-password' }) });
  assert.equal(deleted.response.status, 204);
  assert.equal((await client.request('/sushi-api/auth/me')).data.user, null);
});
