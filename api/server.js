// Production / dev entry point. All wiring lives in db/database.js (openDb,
// resolveDataPaths), app.js (createApp) and start.js (startServer) so tests
// can boot in-process.
import { openDb, resolveDataPaths } from './db/database.js';
import { startServer } from './start.js';

const env = process.env;
try {
  const { dbPath, dataDir, warnings } = resolveDataPaths(env); // throws if the DB is off the volume
  for (const w of warnings) console.warn(JSON.stringify({ level: 'warn', msg: w }));
  const db = await openDb(dbPath);
  await startServer({ db, env, dataDir, port: Number(env.PORT) || 3101, handleSignals: true });
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: err.message }));
  process.exit(1);
}
