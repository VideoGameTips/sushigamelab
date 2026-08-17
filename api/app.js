import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { GAMES, findMode } from './config.js';
import { createStore } from './store.js';
import {
  hashPassword, hashToken, makeDisplayName, makeRecoveryCode, normalizeUsername,
  randomToken, validateCredentials, verifyAttestation, verifyPassword, verifyToken
} from './security.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_PREFIX = '/sushi-api';
const SESSION_COOKIE = 'sgl_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_MS = 6 * 60 * 60 * 1000;

function publicUser(row) {
  return row ? { id: row.user_id || row.id, username: row.username, displayName: row.display_name || row.displayName } : null;
}

function safeVersion(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown';
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function createApp(options = {}) {
  const publicDir = options.publicDir || path.resolve(HERE, '..');
  const production = process.env.NODE_ENV === 'production';
  const configuredDbPath = options.dbPath || process.env.SGL_DB_PATH;
  if (production && !configuredDbPath) throw new Error('SGL_DB_PATH is required in production.');
  const dbPath = path.resolve(configuredDbPath || path.join(os.tmpdir(), 'sushigamelab-dev', 'sushigamelab.sqlite'));
  if (isInside(publicDir, dbPath)) throw new Error('SGL_DB_PATH must be outside the public website directory.');
  const secureCookies = options.secureCookies ?? production;
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || (production ? 'https://sushigamelab.com' : '');
  const minimumRunSeconds = options.minimumRunSeconds ?? 10;
  // Both optional. Unset means the feature is off: no trusted scorer can mark anything
  // 'verified', and the moderation routes answer 404 as though they were never added.
  const verifierSecret = options.verifierSecret ?? process.env.SGL_VERIFIER_SECRET ?? '';
  const adminToken = options.adminToken ?? process.env.SGL_ADMIN_TOKEN ?? '';
  const store = createStore(dbPath);
  const app = express();
  app.locals.store = store;

  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '32kb', type: 'application/json' }));
  app.use(cookieParser());

  app.use(API_PREFIX, (req, res, next) => {
    res.set('cache-control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        const expectedOrigin = publicOrigin ? new URL(publicOrigin).origin : `${req.protocol}://${req.get('host')}`;
        if (new URL(req.headers.origin).origin !== expectedOrigin) return res.status(403).json({ error: 'Cross-site request blocked.' });
      } catch {
        return res.status(403).json({ error: 'Cross-site request blocked.' });
      }
    }
    next();
  });

  const authLimit = options.disableRateLimits ? (_req, _res, next) => next() : rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 15,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many account attempts. Please wait a few minutes.' }
  });

  const runLimit = options.disableRateLimits ? (_req, _res, next) => next() : rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    keyGenerator: req => String(req.session?.user_id || 'guest'),
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many ranking updates. Please wait a minute.' }
  });

  const boardLimit = options.disableRateLimits ? (_req, _res, next) => next() : rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many leaderboard refreshes. Please wait a moment.' }
  });

  function issueSession(res, userId, authVersion) {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const now = Date.now();
    const created = store.createSession({ tokenHash: hashToken(token), userId, csrfToken, authVersion, createdAt: now, expiresAt: now + SESSION_MS });
    if (!created) throw Object.assign(new Error('Credentials changed while signing in.'), { code: 'CREDENTIAL_CHANGED' });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MS
    });
    return csrfToken;
  }

  function readSession(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    return token ? store.getSession(hashToken(token)) : null;
  }

  function requireSession(req, res, next) {
    req.session = readSession(req);
    if (!req.session) return res.status(401).json({ error: 'Sign in to use this feature.' });
    next();
  }

  function requireCsrf(req, res, next) {
    const supplied = String(req.get('x-csrf-token') || '');
    if (!req.session || !supplied || !verifyToken(supplied, hashToken(req.session.csrf_token))) {
      return res.status(403).json({ error: 'Session check failed. Refresh and try again.' });
    }
    next();
  }

  app.get(`${API_PREFIX}/health`, (_req, res) => res.json({ ok: true, service: 'sushi-id', accounts: true, leaderboards: true }));

  app.get(`${API_PREFIX}/auth/me`, (req, res) => {
    const session = readSession(req);
    res.json({ user: publicUser(session), csrfToken: session?.csrf_token || '' });
  });

  app.post(`${API_PREFIX}/auth/register`, authLimit, async (req, res, next) => {
    try {
      const credentials = validateCredentials(req.body?.username, req.body?.password);
      if (credentials.error) return res.status(400).json({ error: credentials.error });
      if (store.getUserByUsername(credentials.usernameKey)) return res.status(409).json({ error: 'That username is unavailable.' });

      const recoveryCode = makeRecoveryCode();
      const user = {
        id: randomUUID(), username: credentials.username, usernameKey: credentials.usernameKey,
        displayName: '', passwordHash: await hashPassword(credentials.password),
        recoveryHash: hashToken(recoveryCode), authVersion: 1, createdAt: Date.now()
      };
      let created = false;
      for (let attempt = 0; attempt < 12 && !created; attempt += 1) {
        user.displayName = makeDisplayName();
        try { store.createUser(user); created = true; }
        catch (error) {
          if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
          if (store.getUserByUsername(credentials.usernameKey)) return res.status(409).json({ error: 'That username is unavailable.' });
          if (!store.getUserByDisplayName(user.displayName)) throw error;
        }
      }
      if (!created) return res.status(503).json({ error: 'Could not assign a player nickname. Please try again.' });
      const csrfToken = issueSession(res, user.id, user.authVersion);
      res.status(201).json({ user: publicUser(user), csrfToken, recoveryCode });
    } catch (error) { next(error); }
  });

  app.post(`${API_PREFIX}/auth/login`, authLimit, async (req, res, next) => {
    try {
      const usernameKey = normalizeUsername(req.body?.username);
      const password = String(req.body?.password || '');
      const user = store.getUserByUsername(usernameKey);
      const valid = user && await verifyPassword(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Username or password is incorrect.' });
      const csrfToken = issueSession(res, user.id, user.auth_version);
      res.json({ user: publicUser(user), csrfToken });
    } catch (error) {
      if (error.code === 'CREDENTIAL_CHANGED') return res.status(409).json({ error: 'Password changed while signing in. Try again.' });
      next(error);
    }
  });

  app.post(`${API_PREFIX}/auth/logout`, requireSession, requireCsrf, (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) store.deleteSession(hashToken(token));
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });

  app.post(`${API_PREFIX}/auth/recover`, authLimit, async (req, res, next) => {
    try {
      const user = store.getUserByUsername(normalizeUsername(req.body?.username));
      const credentials = validateCredentials(req.body?.username, req.body?.newPassword);
      const recoveryCode = String(req.body?.recoveryCode || '').trim().toLowerCase();
      if (!user || credentials.error || !verifyToken(recoveryCode, user.recovery_hash)) {
        return res.status(401).json({ error: 'Recovery details are incorrect.' });
      }
      const nextRecoveryCode = makeRecoveryCode();
      const recovered = store.recoverUser({
        userId: user.id, authVersion: user.auth_version, oldRecoveryHash: user.recovery_hash,
        passwordHash: await hashPassword(credentials.password), recoveryHash: hashToken(nextRecoveryCode)
      });
      if (!recovered) return res.status(409).json({ error: 'That recovery code was already used. Start again.' });
      const csrfToken = issueSession(res, user.id, user.auth_version + 1);
      res.json({ user: publicUser(user), csrfToken, recoveryCode: nextRecoveryCode });
    } catch (error) {
      if (error.code === 'CREDENTIAL_CHANGED') return res.status(409).json({ error: 'Credentials changed while recovering the account. Sign in again.' });
      next(error);
    }
  });

  app.delete(`${API_PREFIX}/auth/account`, requireSession, requireCsrf, authLimit, async (req, res, next) => {
    try {
      const user = store.getUserById(req.session.user_id);
      if (!user || !await verifyPassword(String(req.body?.password || ''), user.password_hash)) {
        return res.status(401).json({ error: 'Password is incorrect.' });
      }
      if (!store.deleteUser(user.id, req.session.auth_version)) {
        return res.status(409).json({ error: 'Credentials changed while deleting the account. Sign in again.' });
      }
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.get(`${API_PREFIX}/leaderboards/config`, boardLimit, (_req, res) => {
    res.set('cache-control', 'public, max-age=300');
    res.json({ games: GAMES });
  });

  app.post(`${API_PREFIX}/runs/start`, requireSession, requireCsrf, runLimit, (req, res) => {
    const gameSlug = String(req.body?.gameSlug || '');
    const modeSlug = String(req.body?.modeSlug || '');
    if (!findMode(gameSlug, modeSlug)) return res.status(400).json({ error: 'Unknown leaderboard challenge.' });
    const now = Date.now();
    store.cleanup(now);
    if (store.countOpenRuns(req.session.user_id, now) >= 5) return res.status(429).json({ error: 'Finish or wait for an earlier ranked run before starting another.' });
    if (store.countRecentScores(req.session.user_id, now - 24 * 60 * 60 * 1000) >= 500) return res.status(429).json({ error: 'Daily community-score limit reached.' });
    const id = randomUUID();
    const runToken = randomToken();
    store.createRun({
      id, userId: req.session.user_id, gameSlug, modeSlug, tokenHash: hashToken(runToken),
      clientVersion: safeVersion(req.body?.clientVersion), startedAt: now, expiresAt: now + RUN_MS
    });
    res.status(201).json({ runId: id, runToken, expiresAt: now + RUN_MS, ranking: 'community' });
  });

  app.post(`${API_PREFIX}/runs/:runId/finish`, requireSession, requireCsrf, runLimit, (req, res, next) => {
    try {
      const run = store.getRun(req.params.runId);
      const now = Date.now();
      if (!run || run.user_id !== req.session.user_id || !verifyToken(req.body?.runToken, run.token_hash)) {
        return res.status(404).json({ error: 'Ranked run not found.' });
      }
      if (run.status !== 'open') return res.status(409).json({ error: 'Run already finished.' });
      if (run.expires_at < now) return res.status(410).json({ error: 'Ranked run expired.' });
      if ((now - run.started_at) / 1000 < minimumRunSeconds) return res.status(400).json({ error: 'Run finished too quickly to rank.' });
      const found = findMode(run.game_slug, run.mode_slug);
      const value = Number(req.body?.value);
      if (!Number.isSafeInteger(value) || value < found.mode.min || value > found.mode.max) {
        return res.status(400).json({ error: 'Score is outside the allowed range.' });
      }
      const metadata = req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata) ? req.body.metadata : {};
      if (metadata.cheatEnabled) return res.status(400).json({ error: 'Cheat-enabled runs are not ranked.' });
      const metadataJson = JSON.stringify(metadata);
      if (Buffer.byteLength(metadataJson) > 4096) return res.status(413).json({ error: 'Run details are too large.' });
      // A score is 'verified' only when a trusted scorer signed this exact run and
      // value. The browser relays the signature but cannot produce one, so a modified
      // client can still post a score — it just cannot promote it past 'community'.
      const verification = verifyAttestation(verifierSecret, run.id, run.mode_slug, value, metadata.attestation)
        ? 'verified' : 'community';

      const score = {
        id: randomUUID(), runId: run.id, userId: run.user_id, gameSlug: run.game_slug,
        modeSlug: run.mode_slug, value, verification, metadataJson, achievedAt: now
      };
      store.finishRun(score);
      res.status(201).json({ accepted: true, verification, score: { value, achievedAt: now } });
    } catch (error) {
      if (error.code === 'RUN_FINISHED' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Run already finished.' });
      next(error);
    }
  });

  app.get(`${API_PREFIX}/leaderboards/:gameSlug/:modeSlug`, boardLimit, (req, res) => {
    const found = findMode(req.params.gameSlug, req.params.modeSlug);
    if (!found) return res.status(404).json({ error: 'Leaderboard not found.' });
    const period = ['week', 'season', 'all'].includes(req.query.period) ? req.query.period : 'week';
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const session = readSession(req);
    const board = store.leaderboard({
      gameSlug: found.game.slug, modeSlug: found.mode.slug, period,
      direction: found.mode.direction, limit, userId: session?.user_id
    });
    if (!session) res.set('cache-control', 'public, max-age=10, s-maxage=30, stale-while-revalidate=60');
    const mapRow = row => ({ rank: row.board_rank, displayName: row.display_name, value: row.value, verification: row.verification, achievedAt: row.achieved_at });
    res.json({
      game: found.game.slug, mode: found.mode.slug, period, verification: 'community',
      entries: board.rows.map(mapRow),
      me: board.me ? { rank: board.me.board_rank, displayName: board.me.display_name, value: board.me.value, achievedAt: board.me.achieved_at } : null
    });
  });

  // ---- moderation -----------------------------------------------------------------
  //
  // The schema always had disabled_at, removed_at and removal_reason, and nine queries
  // filtered on them, but nothing could ever set them — so a bad entry on a children's
  // leaderboard could only be dealt with by hand-editing SQLite on the server. These
  // routes close that gap.
  //
  // Auth is a shared token rather than a role on the user model: adding "admin" to an
  // account would mean one compromised child login could rewrite the board, and the
  // people who moderate this site are the parents who already hold the server.
  // The token travels in a header, never a query string — the reverse proxy logs URIs.
  // Every other sensitive route here is throttled; these must be too. The token is the
  // only thing between the open internet and rewriting a children's leaderboard, and an
  // unthrottled endpoint is an invitation to sit and guess at it.
  const adminLimit = options.disableRateLimits ? (_req, _res, next) => next() : rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many moderation requests. Please wait a few minutes.' }
  });

  function requireAdmin(req, res, next) {
    if (!adminToken) return res.status(404).json({ error: 'API route not found.' });
    const supplied = String(req.get('x-admin-token') || '');
    if (!supplied || !verifyToken(supplied, hashToken(adminToken))) {
      return res.status(401).json({ error: 'Moderation token is incorrect.' });
    }
    next();
  }

  app.get(`${API_PREFIX}/admin/scores`, adminLimit, requireAdmin, (req, res) => {
    const game = req.query.game ? String(req.query.game) : null;
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    res.json({ scores: store.recentScoresForReview(game, limit) });
  });

  app.post(`${API_PREFIX}/admin/scores/:scoreId`, adminLimit, requireAdmin, (req, res) => {
    const hide = req.body?.removed !== false;
    const changed = hide
      ? store.removeScore(req.params.scoreId, req.body?.reason)
      : store.restoreScore(req.params.scoreId);
    if (!changed) return res.status(404).json({ error: 'Score not found, or already in that state.' });
    res.json({ ok: true, removed: hide });
  });

  app.post(`${API_PREFIX}/admin/users/:userId`, adminLimit, requireAdmin, (req, res) => {
    const disable = req.body?.disabled !== false;
    if (!store.setUserDisabled(req.params.userId, disable)) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    res.json({ ok: true, disabled: disable });
  });

  app.use(API_PREFIX, (_req, res) => res.status(404).json({ error: 'API route not found.' }));

  if (options.serveStatic !== false) {
    const frontendFiles = ['account.css', 'account.js', 'leaderboard.css', 'leaderboard.js', 'logo.svg', 'og-cover.png', 'robots.txt', 'sitemap.xml'];
    app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
    app.get('/leaderboard.html', (_req, res) => res.sendFile(path.join(publicDir, 'leaderboard.html')));
    frontendFiles.forEach(file => app.get(`/${file}`, (_req, res) => res.sendFile(path.join(publicDir, file))));
  }
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large' || error?.status === 413) return res.status(413).json({ error: 'Request body is too large.' });
    if (error?.status === 415) return res.status(415).json({ error: 'Request body must use JSON.' });
    if (error?.type === 'entity.parse.failed' || error?.status === 400) return res.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error('[sushi-id]', { name: error?.name || 'Error', code: error?.code || 'UNEXPECTED' });
    res.status(500).json({ error: 'The Sushi ID server had a problem.' });
  });
  return app;
}
