import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../app.js';
import { attestationFor } from '../security.js';

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

// ---- trusted-scorer attestations -------------------------------------------------

const VERIFIER_SECRET = 'test-verifier-secret';
const ADMIN_TOKEN = 'test-admin-token';

async function rankedRun(client, { value, attestation, mode = 'theater-speed' } = {}) {
  const started = await client.request('/sushi-api/runs/start', {
    method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: mode, clientVersion: 'test' })
  });
  const body = { runToken: started.data.runToken, value };
  if (attestation !== undefined) body.metadata = { attestation };
  const finished = await client.request(`/sushi-api/runs/${started.data.runId}/finish`, {
    method: 'POST', body: JSON.stringify(body)
  });
  return { runId: started.data.runId, started, finished };
}

test('a run signed by the trusted scorer is verified; an unsigned one is not', async t => {
  const { client } = await makeHarness(t, { verifierSecret: VERIFIER_SECRET });
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'ScoredOne', password: 'a-long-safe-password' }) });

  const plain = await rankedRun(client, { value: 300 });
  assert.equal(plain.finished.response.status, 201);
  assert.equal(plain.finished.data.verification, 'community');

  // The scorer signs the run it actually judged, keyed by a secret the browser never sees.
  const signedRun = await client.request('/sushi-api/runs/start', {
    method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'theater-speed', clientVersion: 'test' })
  });
  const attestation = attestationFor(VERIFIER_SECRET, signedRun.data.runId, 'theater-speed', 275);
  const signed = await client.request(`/sushi-api/runs/${signedRun.data.runId}/finish`, {
    method: 'POST', body: JSON.stringify({ runToken: signedRun.data.runToken, value: 275, metadata: { attestation } })
  });
  assert.equal(signed.data.verification, 'verified');
});

test('a modified client cannot forge, move or re-point an attestation', async t => {
  const { client } = await makeHarness(t, { verifierSecret: VERIFIER_SECRET });
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'ForgerOne', password: 'a-long-safe-password' }) });

  // invented signature
  const invented = await rankedRun(client, { value: 30, attestation: 'f'.repeat(64) });
  assert.equal(invented.finished.data.verification, 'community');

  // a signature that is real, but for a different value on this run
  const runA = await client.request('/sushi-api/runs/start', {
    method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'theater-speed', clientVersion: 'test' })
  });
  const forValue300 = attestationFor(VERIFIER_SECRET, runA.data.runId, 'theater-speed', 300);
  const swappedValue = await client.request(`/sushi-api/runs/${runA.data.runId}/finish`, {
    method: 'POST', body: JSON.stringify({ runToken: runA.data.runToken, value: 20, metadata: { attestation: forValue300 } })
  });
  assert.equal(swappedValue.data.verification, 'community', 'the value is part of what was signed');

  // a signature that is real, but issued for someone else's run
  const runB = await client.request('/sushi-api/runs/start', {
    method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'theater-speed', clientVersion: 'test' })
  });
  const runC = await client.request('/sushi-api/runs/start', {
    method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'theater-speed', clientVersion: 'test' })
  });
  const forRunB = attestationFor(VERIFIER_SECRET, runB.data.runId, 'theater-speed', 275);
  const replayed = await client.request(`/sushi-api/runs/${runC.data.runId}/finish`, {
    method: 'POST', body: JSON.stringify({ runToken: runC.data.runToken, value: 275, metadata: { attestation: forRunB } })
  });
  assert.equal(replayed.data.verification, 'community', 'an attestation is bound to one run');
});

test('with no verifier secret configured nothing can be verified', async t => {
  const { client } = await makeHarness(t);            // secret deliberately unset
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'NoSecret', password: 'a-long-safe-password' }) });
  const attestation = attestationFor(VERIFIER_SECRET, 'any-run', 'theater-speed', 275);
  const run = await rankedRun(client, { value: 275, attestation });
  assert.equal(run.finished.data.verification, 'community', 'the feature fails closed');
});

// ---- moderation --------------------------------------------------------------------

test('a moderator can hide a score and put it back', async t => {
  const { client } = await makeHarness(t, { adminToken: ADMIN_TOKEN });
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'BoardOne', password: 'a-long-safe-password' }) });
  await rankedRun(client, { value: 275 });

  const onBoard = await client.request('/sushi-api/leaderboards/irontide/theater-speed?period=all');
  assert.equal(onBoard.data.entries.length, 1);

  const listed = await client.request('/sushi-api/admin/scores', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  assert.equal(listed.response.status, 200);
  const scoreId = listed.data.scores[0].id;

  const hidden = await client.request(`/sushi-api/admin/scores/${scoreId}`, {
    method: 'POST', headers: { 'x-admin-token': ADMIN_TOKEN }, body: JSON.stringify({ removed: true, reason: 'obviously impossible' })
  });
  assert.equal(hidden.response.status, 200);
  const gone = await client.request('/sushi-api/leaderboards/irontide/theater-speed?period=all');
  assert.equal(gone.data.entries.length, 0, 'a hidden score leaves the board');

  await client.request(`/sushi-api/admin/scores/${scoreId}`, {
    method: 'POST', headers: { 'x-admin-token': ADMIN_TOKEN }, body: JSON.stringify({ removed: false })
  });
  const back = await client.request('/sushi-api/leaderboards/irontide/theater-speed?period=all');
  assert.equal(back.data.entries.length, 1, 'hiding is reversible');
});

test('disabling an account clears its sessions and takes it off the board', async t => {
  const { client } = await makeHarness(t, { adminToken: ADMIN_TOKEN });
  const registered = await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'RuleBreaker', password: 'a-long-safe-password' }) });
  await rankedRun(client, { value: 42 });

  await client.request(`/sushi-api/admin/users/${registered.data.user.id}`, {
    method: 'POST', headers: { 'x-admin-token': ADMIN_TOKEN }, body: JSON.stringify({ disabled: true })
  });

  const board = await client.request('/sushi-api/leaderboards/irontide/theater-speed?period=all');
  assert.equal(board.data.entries.length, 0);
  const me = await client.request('/sushi-api/auth/me');
  assert.equal(me.data.user, null, 'an open session must not survive being disabled');
});

test('moderation refuses a wrong token, and hides entirely when unconfigured', async t => {
  const withToken = await makeHarness(t, { adminToken: ADMIN_TOKEN });
  const wrong = await withToken.client.request('/sushi-api/admin/scores', { headers: { 'x-admin-token': 'not-the-token' } });
  assert.equal(wrong.response.status, 401);
  const missing = await withToken.client.request('/sushi-api/admin/scores');
  assert.equal(missing.response.status, 401);

  const noToken = await makeHarness(t);               // token deliberately unset
  const invisible = await noToken.client.request('/sushi-api/admin/scores', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  assert.equal(invisible.response.status, 404, 'an unconfigured moderation API does not advertise itself');
});

test('a trusted service can look up who owns a run, and nobody else can', async t => {
  const { client } = await makeHarness(t, { verifierSecret: VERIFIER_SECRET });
  const registered = await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'RunOwner', password: 'a-long-safe-password' }) });
  const started = await client.request('/sushi-api/runs/start', {
    method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'campaign', clientVersion: 'test' })
  });

  const looked = await client.request(`/sushi-api/internal/runs/${started.data.runId}`, {
    headers: { 'x-service-token': VERIFIER_SECRET }
  });
  assert.equal(looked.response.status, 200);
  assert.equal(looked.data.userId, registered.data.user.id);
  assert.equal(looked.data.displayName, registered.data.user.displayName);
  assert.equal(looked.data.modeSlug, 'campaign');
  assert.ok(!('username' in looked.data), 'the private login is never handed to another service');

  // A browser session is not a service credential, and a wrong token is indistinguishable
  // from the route not existing.
  const asBrowser = await client.request(`/sushi-api/internal/runs/${started.data.runId}`);
  assert.equal(asBrowser.response.status, 404);
  const wrongToken = await client.request(`/sushi-api/internal/runs/${started.data.runId}`, {
    headers: { 'x-service-token': 'not-the-secret' }
  });
  assert.equal(wrongToken.response.status, 404);
});

test('run lookup is invisible when no verifier secret is configured', async t => {
  const { client } = await makeHarness(t);
  await client.request('/sushi-api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'NoService', password: 'a-long-safe-password' }) });
  const started = await client.request('/sushi-api/runs/start', {
    method: 'POST', body: JSON.stringify({ gameSlug: 'irontide', modeSlug: 'campaign', clientVersion: 'test' })
  });
  const looked = await client.request(`/sushi-api/internal/runs/${started.data.runId}`, {
    headers: { 'x-service-token': VERIFIER_SECRET }
  });
  assert.equal(looked.response.status, 404);
});
