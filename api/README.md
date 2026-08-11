# Sushi ID API

Optional site-wide accounts and community leaderboards for Sushi Game Lab.
Guest play remains independent of this service.

## Local preview

```bash
cd api
npm install
npm test
npm start
```

Open <http://127.0.0.1:3030/>. The service serves the portal during local
development and exposes JSON endpoints below `/sushi-api`. This namespace is
kept separate from PVP Arena's existing `/api/chat` endpoint.

## Production environment

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=3030
PUBLIC_ORIGIN=https://sushigamelab.com
SGL_DB_PATH=/var/lib/sushigamelab/sushigamelab.sqlite
```

The database directory must be writable only by the service user and included
in encrypted daily backups. Never place the database in the public web root.

Reverse proxy `/sushi-api/*` to this service through Caddy. Keep every other
portal file served statically, preserve PVP's `/api/chat`, and deny static
access to the checkout's `/api/*` and `/ops/*` directories. See `../ops/` for
the reviewed service unit, Caddy route and backup procedure. Do not copy the
PVP server's wildcard CORS or plaintext-password format into this service.

## Score trust

Scores are deliberately labelled `community`. A start token prevents casual
replay and the finish endpoint rejects impossible ranges, expired runs,
duplicates, extremely short runs and runs marked with cheats. A browser client
can still be modified, so a `verified` badge must only be enabled after that
game moves its scoring decisions or replay validation to a trusted server.
