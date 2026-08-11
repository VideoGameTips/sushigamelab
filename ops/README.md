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
