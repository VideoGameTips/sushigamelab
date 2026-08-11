import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '127.0.0.1';
const app = createApp();
const server = app.listen(PORT, HOST, () => {
  console.log(`Sushi ID + leaderboard server listening on http://${HOST}:${PORT}`);
});

const cleanup = setInterval(() => app.locals.store.cleanup(), 60 * 60 * 1000);
cleanup.unref();

function shutdown() {
  clearInterval(cleanup);
  server.close(() => {
    app.locals.store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
