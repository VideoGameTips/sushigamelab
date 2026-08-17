import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// SGL_WEEK_TZ_OFFSET_MIN shifts the weekly and seasonal boundaries into the players'
// own timezone. Left at 0 the periods roll over at UTC midnight, which on the Pacific
// coast lands mid-Sunday-afternoon — "this week" would reset while everyone is playing.
// A fixed offset drifts by an hour across daylight saving; for a leaderboard reset that
// is not worth carrying a timezone database.
const WEEK_TZ_OFFSET_MIN = Number(process.env.SGL_WEEK_TZ_OFFSET_MIN || 0);

function periodCutoff(period, now = Date.now(), offsetMin = WEEK_TZ_OFFSET_MIN) {
  const date = new Date(now + offsetMin * 60000);
  if (period === 'week') {
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime() - offsetMin * 60000;
  }
  if (period === 'season') {
    const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
    return Date.UTC(date.getUTCFullYear(), quarterMonth, 1) - offsetMin * 60000;
  }
  return 0;
}

export function createStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try { fs.chmodSync(dbPath, 0o600); } catch { /* Best effort on non-POSIX development machines. */ }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL,
      auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version >= 1),
      created_at INTEGER NOT NULL,
      disabled_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version >= 1)
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_slug TEXT NOT NULL,
      mode_slug TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      client_version TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','finished'))
    );
    CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id);
    CREATE INDEX IF NOT EXISTS runs_expiry ON runs(expires_at);
    CREATE TABLE IF NOT EXISTS scores (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_slug TEXT NOT NULL,
      mode_slug TEXT NOT NULL,
      value INTEGER NOT NULL,
      verification TEXT NOT NULL DEFAULT 'community' CHECK(verification IN ('community','verified')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      achieved_at INTEGER NOT NULL,
      removed_at INTEGER,
      removal_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS scores_board ON scores(game_slug, mode_slug, achieved_at, value);
    CREATE INDEX IF NOT EXISTS scores_user ON scores(user_id);
  `);

  // Forward-compatible migration for databases created by the earliest local
  // prototype. Production starts at schema version 1, but these guards make a
  // redeploy safe if somebody already tried the preview API.
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name));
  if (!userColumns.has('auth_version')) db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1');
  if (!sessionColumns.has('auth_version')) db.exec('ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_unique ON users(display_name)');

  // Widen the verification constraint so a trusted scorer can mark a run 'verified'.
  // SQLite cannot alter a CHECK in place, so the table has to be rebuilt. The guard
  // reads the stored DDL rather than user_version: it stays correct even if a database
  // was created before versions were tracked, and it is a no-op once the column allows
  // the new value. CREATE TABLE above already carries the wider constraint, so a fresh
  // database rebuilds nothing.
  const scoresDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scores'").get()?.sql || '';
  if (!scoresDdl.includes("'verified'")) {
    // foreign_keys cannot be toggled inside a transaction, hence the order here — and
    // hence the try/finally: if the rebuild throws, enforcement has to come back on
    // regardless, or the rest of this process would run with foreign keys silently off.
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
      BEGIN;
      CREATE TABLE scores_migrating (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_slug TEXT NOT NULL,
        mode_slug TEXT NOT NULL,
        value INTEGER NOT NULL,
        verification TEXT NOT NULL DEFAULT 'community' CHECK(verification IN ('community','verified')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        achieved_at INTEGER NOT NULL,
        removed_at INTEGER,
        removal_reason TEXT
      );
      INSERT INTO scores_migrating (id,run_id,user_id,game_slug,mode_slug,value,verification,metadata_json,achieved_at,removed_at,removal_reason)
        SELECT id,run_id,user_id,game_slug,mode_slug,value,verification,metadata_json,achieved_at,removed_at,removal_reason FROM scores;
      DROP TABLE scores;
      ALTER TABLE scores_migrating RENAME TO scores;
      CREATE INDEX IF NOT EXISTS scores_board ON scores(game_slug, mode_slug, achieved_at, value);
      CREATE INDEX IF NOT EXISTS scores_user ON scores(user_id);
        COMMIT;
      `);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    const check = db.pragma('foreign_key_check', { simple: false });
    if (check.length) throw new Error(`Score migration left ${check.length} dangling reference(s).`);
  }

  db.pragma('user_version = 2');

  const statements = {
    createUser: db.prepare('INSERT INTO users (id, username, username_key, display_name, password_hash, recovery_hash, auth_version, created_at) VALUES (@id,@username,@usernameKey,@displayName,@passwordHash,@recoveryHash,@authVersion,@createdAt)'),
    userByKey: db.prepare('SELECT * FROM users WHERE username_key=? AND disabled_at IS NULL'),
    userById: db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL'),
    userByDisplayName: db.prepare('SELECT id FROM users WHERE display_name=?'),
    createSession: db.prepare(`INSERT INTO sessions (token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at,auth_version)
      SELECT @tokenHash,id,@csrfToken,@createdAt,@expiresAt,@createdAt,@authVersion
      FROM users WHERE id=@userId AND auth_version=@authVersion AND disabled_at IS NULL`),
    session: db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,s.last_seen_at,u.id AS user_id,u.username,u.display_name,u.auth_version
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND s.auth_version=u.auth_version AND u.disabled_at IS NULL`),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id=?'),
    recoverUser: db.prepare(`UPDATE users SET password_hash=@passwordHash,recovery_hash=@recoveryHash,auth_version=auth_version+1
      WHERE id=@userId AND recovery_hash=@oldRecoveryHash AND auth_version=@authVersion AND disabled_at IS NULL`),
    deleteUser: db.prepare('DELETE FROM users WHERE id=? AND auth_version=?'),
    createRun: db.prepare('INSERT INTO runs (id,user_id,game_slug,mode_slug,token_hash,client_version,started_at,expires_at) VALUES (@id,@userId,@gameSlug,@modeSlug,@tokenHash,@clientVersion,@startedAt,@expiresAt)'),
    run: db.prepare('SELECT * FROM runs WHERE id=?'),
    openRuns: db.prepare("SELECT COUNT(*) AS count FROM runs WHERE user_id=? AND status='open' AND expires_at>=?"),
    recentScores: db.prepare('SELECT COUNT(*) AS count FROM scores WHERE user_id=? AND achieved_at>=?'),
    finishRun: db.prepare("UPDATE runs SET finished_at=?,status='finished' WHERE id=? AND status='open'"),
    createScore: db.prepare('INSERT INTO scores (id,run_id,user_id,game_slug,mode_slug,value,verification,metadata_json,achieved_at) VALUES (@id,@runId,@userId,@gameSlug,@modeSlug,@value,@verification,@metadataJson,@achievedAt)'),
    cleanupSessions: db.prepare('DELETE FROM sessions WHERE expires_at<?'),
    cleanupRuns: db.prepare("DELETE FROM runs WHERE status='open' AND expires_at<?"),

    // ---- moderation ----
    // `disabled_at`, `removed_at` and `removal_reason` were filtered by nine queries but
    // never written by anything, so a bad score could only be dealt with by hand-editing
    // the database. These give the parent-facing routes something to call. Hiding is
    // always reversible; deleting an account stays the only destructive operation.
    removeScore: db.prepare('UPDATE scores SET removed_at=@now, removal_reason=@reason WHERE id=@id AND removed_at IS NULL'),
    restoreScore: db.prepare('UPDATE scores SET removed_at=NULL, removal_reason=NULL WHERE id=@id'),
    setUserDisabled: db.prepare('UPDATE users SET disabled_at=@at WHERE id=@id'),
    recentScoresForReview: db.prepare(`
      SELECT s.id, s.user_id, s.game_slug, s.mode_slug, s.value, s.verification,
             s.metadata_json, s.achieved_at, s.removed_at, s.removal_reason,
             u.display_name, u.username, u.disabled_at
      FROM scores s JOIN users u ON u.id = s.user_id
      WHERE (@game IS NULL OR s.game_slug = @game)
      ORDER BY s.achieved_at DESC LIMIT @limit
    `)
  };

  const finishTransaction = db.transaction(score => {
    const changed = statements.finishRun.run(score.achievedAt, score.runId).changes;
    if (changed !== 1) throw Object.assign(new Error('Run already finished.'), { code: 'RUN_FINISHED' });
    statements.createScore.run(score);
  });

  function leaderboard({ gameSlug, modeSlug, period, direction, limit, userId, now = Date.now() }) {
    const cutoff = periodCutoff(period, now);
    const order = direction === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(`
      WITH ranked_scores AS (
        SELECT s.*, ROW_NUMBER() OVER (
          PARTITION BY s.user_id ORDER BY s.value ${order}, s.achieved_at ASC
        ) AS player_pick
        FROM scores s
        WHERE s.game_slug=? AND s.mode_slug=? AND s.achieved_at>=? AND s.removed_at IS NULL
      ), board AS (
        SELECT rs.user_id,rs.value,rs.verification,rs.achieved_at,u.display_name,
          ROW_NUMBER() OVER (ORDER BY rs.value ${order}, rs.achieved_at ASC) AS board_rank
        FROM ranked_scores rs JOIN users u ON u.id=rs.user_id
        WHERE rs.player_pick=1 AND u.disabled_at IS NULL
      )
      SELECT * FROM board ORDER BY board_rank ASC LIMIT ?
    `).all(gameSlug, modeSlug, cutoff, limit);
    let me = null;
    if (userId) {
      me = db.prepare(`
        WITH ranked_scores AS (
          SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.value ${order},s.achieved_at ASC) AS player_pick
          FROM scores s WHERE s.game_slug=? AND s.mode_slug=? AND s.achieved_at>=? AND s.removed_at IS NULL
        ), board AS (
          SELECT rs.user_id,rs.value,rs.achieved_at,u.display_name,
            ROW_NUMBER() OVER (ORDER BY rs.value ${order},rs.achieved_at ASC) AS board_rank
          FROM ranked_scores rs JOIN users u ON u.id=rs.user_id
          WHERE rs.player_pick=1 AND u.disabled_at IS NULL
        ) SELECT * FROM board WHERE user_id=?
      `).get(gameSlug, modeSlug, cutoff, userId) || null;
    }
    return { rows, me };
  }

  return {
    db,
    createUser(user) { statements.createUser.run(user); },
    getUserByUsername(usernameKey) { return statements.userByKey.get(usernameKey); },
    getUserById(id) { return statements.userById.get(id); },
    getUserByDisplayName(displayName) { return statements.userByDisplayName.get(displayName) || null; },
    createSession(session) { return statements.createSession.run(session).changes === 1; },
    getSession(tokenHash, now = Date.now()) {
      const session = statements.session.get(tokenHash, now);
      if (session && now - session.last_seen_at > 60_000) statements.touchSession.run(now, tokenHash);
      return session || null;
    },
    deleteSession(tokenHash) { statements.deleteSession.run(tokenHash); },
    recoverUser({ userId, authVersion, oldRecoveryHash, passwordHash, recoveryHash }) {
      return db.transaction(() => {
        const changed = statements.recoverUser.run({ userId, authVersion, oldRecoveryHash, passwordHash, recoveryHash }).changes;
        if (changed !== 1) return false;
        statements.deleteUserSessions.run(userId);
        return true;
      })();
    },
    deleteUser(userId, authVersion) { return statements.deleteUser.run(userId, authVersion).changes === 1; },
    createRun(run) { statements.createRun.run(run); },
    countOpenRuns(userId, now = Date.now()) { return statements.openRuns.get(userId, now).count; },
    countRecentScores(userId, since) { return statements.recentScores.get(userId, since).count; },
    getRun(id) { return statements.run.get(id) || null; },
    finishRun(score) { finishTransaction(score); },
    leaderboard,
    cleanup(now = Date.now()) { statements.cleanupSessions.run(now); statements.cleanupRuns.run(now); },

    removeScore(id, reason, now = Date.now()) {
      return statements.removeScore.run({ id, reason: String(reason || '').slice(0, 200) || 'removed by a moderator', now }).changes === 1;
    },
    restoreScore(id) { return statements.restoreScore.run({ id }).changes === 1; },
    setUserDisabled(id, disabled, now = Date.now()) {
      return db.transaction(() => {
        const changed = statements.setUserDisabled.run({ id, at: disabled ? now : null }).changes === 1;
        // A disabled account must not keep walking around on an open session.
        if (changed && disabled) statements.deleteUserSessions.run(id);
        return changed;
      })();
    },
    recentScoresForReview(game, limit = 100) {
      return statements.recentScoresForReview.all({ game: game || null, limit });
    },
    close() { db.close(); }
  };
}
