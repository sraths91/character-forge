// Production / dev entry point. All wiring lives in db/database.js (openDb),
// app.js (createApp) and start.js (startServer) so tests can boot in-process.
import { openDb, DEFAULT_DB_PATH } from './db/database.js';
import { startServer } from './start.js';

const env = process.env;
try {
  const db = await openDb(env.CF_DB_PATH || DEFAULT_DB_PATH);
  await startServer({ db, env, port: Number(env.PORT) || 3101, handleSignals: true });
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: err.message }));
  process.exit(1);
}
