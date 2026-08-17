# Sushi ID production operations

These files deploy the optional account and leaderboard API beside the static
Sushi Game Lab portal. Caddy is the only public listener. Node listens on
`127.0.0.1:3030`, and SQLite lives outside the public checkout at:

```text
/var/lib/sushigamelab/sushigamelab.sqlite
```

Never place an account database, backup, environment file, or Node log under
`/opt/games/sushigamelab`; that directory is the site's document root.

## First installation

Run these commands as an administrator on the VPS. Node.js 20 or newer,
`sqlite3`, Caddy, and npm must already be installed.

```bash
sudo useradd --system --home-dir /var/lib/sushigamelab \
  --shell /usr/sbin/nologin sushigamelab

cd /opt/games/sushigamelab/api
sudo npm ci --omit=dev

sudo install -o root -g root -m 0644 \
  /opt/games/sushigamelab/ops/sushigamelab-api.service \
  /etc/systemd/system/sushigamelab-api.service
sudo install -o root -g sushigamelab -m 0640 \
  /opt/games/sushigamelab/ops/sushigamelab-api.env.example \
  /etc/sushigamelab-api.env
sudo systemctl daemon-reload
sudo systemctl enable --now sushigamelab-api.service
```

If the service account already exists, `useradd` will report that fact; leave
the existing system account in place. The unit's `StateDirectory` setting
creates `/var/lib/sushigamelab` with mode `0700` and the correct owner.

Merge `Caddyfile.snippet` into the existing `sushigamelab.com` site block,
before its static fallback. It deliberately preserves PVP's `/api/chat` and
`/api/chat/status` routes, sends `/sushi-api/*` to port 3030, and denies static
downloads from `/api/*` and `/ops/*`. Keep any other existing PVP proxy routes
unchanged.

This server's Caddy configuration has `admin off`, so reload is unavailable.
Validate before restarting, and verify the old service remains running if
validation fails:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo systemctl --no-pager --full status caddy
```

## Health and logs

Test the private listener first, then the public proxy:

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:3030/sushi-api/health
curl --fail --silent --show-error \
  https://sushigamelab.com/sushi-api/health
sudo journalctl -u sushigamelab-api.service -n 100 --no-pager
```

Both health requests should return JSON containing `"ok":true`. Also verify
that source is blocked and PVP chat was not intercepted:

```bash
curl -o /dev/null -sS -w '%{http_code}\n' \
  https://sushigamelab.com/api/app.js
curl --fail --silent --show-error \
  https://sushigamelab.com/api/chat/status
```

The source request must be `404`; the PVP status request must still return its
normal JSON response.

## Safe update

Install dependencies while the old process is still serving, run checks, then
restart only the API:

```bash
cd /opt/games/sushigamelab
git pull --ff-only
cd api
sudo npm ci --omit=dev
sudo npm run check
sudo npm test
sudo systemctl restart sushigamelab-api.service
curl --fail --silent --show-error \
  http://127.0.0.1:3030/sushi-api/health
```

If health fails, inspect the journal immediately and roll the checkout back to
the previously deployed commit before restarting the service again.

## Online backup

Do not copy an open SQLite file with `cp`; WAL data may be missed. Use SQLite's
online backup operation and then check the backup:

```bash
sudo install -d -o root -g root -m 0700 /var/backups/sushigamelab
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/var/backups/sushigamelab/sushigamelab-${stamp}.sqlite"
sudo sqlite3 /var/lib/sushigamelab/sushigamelab.sqlite \
  ".backup '${backup}'"
sudo chmod 0600 "${backup}"
sudo sqlite3 "${backup}" 'PRAGMA integrity_check;'
```

The integrity result must be `ok`. Copy backups to an encrypted off-server
location and apply a retention policy; a backup kept only on this VPS does not
protect against disk loss.

## Restore

Check the backup before stopping the API. Preserve the old state directory so
rollback remains possible, then install the selected database with the service
account as owner:

```bash
backup=/var/backups/sushigamelab/sushigamelab-YYYYMMDDTHHMMSSZ.sqlite
sudo sqlite3 "${backup}" 'PRAGMA integrity_check;'
sudo systemctl stop sushigamelab-api.service
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sudo mv /var/lib/sushigamelab \
  "/var/lib/sushigamelab.pre-restore-${stamp}"
sudo install -d -o sushigamelab -g sushigamelab -m 0700 \
  /var/lib/sushigamelab
sudo install -o sushigamelab -g sushigamelab -m 0600 \
  "${backup}" /var/lib/sushigamelab/sushigamelab.sqlite
sudo systemctl start sushigamelab-api.service
curl --fail --silent --show-error \
  http://127.0.0.1:3030/sushi-api/health
```

Keep the `.pre-restore-*` directory until accounts and leaderboards have been
checked through the public site. Remove it only after the restored service is
confirmed healthy and a fresh off-server backup exists.

## Verified scores

A score is labelled `community` unless a trusted scoring server vouched for it.
That server signs the run it judged:

```text
attestation = HMAC-SHA256(SGL_VERIFIER_SECRET, "<runId>.<modeSlug>.<value>")
```

and the game client relays the value in `metadata.attestation` when finishing the
run. The browser never holds the secret, so a modified client can still post a
score — it simply cannot promote one past `community`. The signature covers the
run id and the value, so it cannot be moved to another run or reused for a
different score. With `SGL_VERIFIER_SECRET` unset the path is off entirely.

Iron Tide is the first game wired this way: its own server runs the handshake,
times the war against its own clock, and bounds the result against the game's
spawn constants before signing. See `irontide/docs/LEADERBOARD.md`.

## Moderation

`disabled_at`, `removed_at` and `removal_reason` were in the schema from the
start but nothing could write them, so a bad entry could only be fixed by editing
SQLite by hand. These routes need `SGL_ADMIN_TOKEN` in an `X-Admin-Token` header
— never a query parameter, because Caddy logs whole URIs.

```bash
TOKEN=...   # from /etc/sushigamelab-api.env

# what has been posted lately
curl -s -H "X-Admin-Token: $TOKEN" https://sushigamelab.com/sushi-api/admin/scores | head

# hide one score, and put it back
curl -s -X POST -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"removed":true,"reason":"impossible time"}' \
  https://sushigamelab.com/sushi-api/admin/scores/<scoreId>
curl -s -X POST -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"removed":false}' https://sushigamelab.com/sushi-api/admin/scores/<scoreId>

# disable an account: it leaves every board and its open sessions are dropped
curl -s -X POST -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"disabled":true}' https://sushigamelab.com/sushi-api/admin/users/<userId>
```

Hiding and disabling are reversible; deleting an account is not.

## Schema migrations

Opening the database upgrades it in place. The one migration so far widens the
`scores.verification` constraint to allow `verified`; SQLite cannot alter a CHECK,
so the table is rebuilt inside a transaction and `foreign_key_check` must come
back clean. It is guarded on the stored DDL rather than `user_version`, so it is a
no-op on an already-migrated database and safe to run repeatedly.

**Back up before deploying a migration** — `/usr/local/bin/sushigamelab-api-backup.sh`.

## Run ownership lookup (service to service)

A game's own scoring server keeps boards this service does not: Iron Tide ranks 31
theatres across three difficulties, while a Sushi ID mode holds one number. Those
detailed boards still have to say *who* set a time, and all the scoring server gets
from the browser is a run id — which a modified client could copy from anybody.

```bash
curl -s -H "X-Service-Token: $SGL_VERIFIER_SECRET" \
  https://sushigamelab.com/sushi-api/internal/runs/<runId>
```

Returns the owning account id and **public display name only** — a scoring server has
no business learning the private login. Browser sessions are not accepted, and a caller
without the secret gets the same 404 as a route that does not exist, so the endpoint
does not advertise itself. Unset `SGL_VERIFIER_SECRET` and it is gone entirely.

## Cache busting for portal assets

Cloudflare applies its own `Cache-Control: max-age=14400` to `.js` and `.css` by
extension, while Caddy serves `.html` as `no-cache`. That combination means every
deployment of a portal script opens a four-hour window where browsers run the OLD
JavaScript against the NEW HTML.

That is not theoretical — it happened on the first deploy of the rankings page: the
markup had dropped `#game-select`, the cached script still looked for it, and the
page died on `addEventListener` of null, stuck on "Loading rankings…".

So the references carry a version:

```html
<script src="/leaderboard.js?v=2026-08-17a" defer></script>
```

**Bump that string whenever `leaderboard.js`, `account.js` or `account.css` changes.**
It is the only fix that reaches a browser which has already cached the old file —
changing headers afterwards does not, because it will not ask again until its
max-age expires.

Caddy additionally serves these three files as `no-cache` (see the site block), so
a browser loading them for the first time after a deploy revalidates. The version
string is what covers everyone else.
