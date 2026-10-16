// Production / dev entry point. All wiring lives in db/database.js (openDb,
// resolveDataPaths), app.js (createApp), start.js (startServer) and
// multiplayer.js (rooms + ws gateway, when CF_MULTIPLAYER=1) so tests can
// boot in-process. CF_MULTIPLAYER is read only here: an in-process boot
// picks startServer or startMultiplayerServer itself.
import { openDb, resolveDataPaths } from './db/database.js';
import { startServer, portFromEnv } from './start.js';
import { startMultiplayerServer } from './multiplayer.js';

const env = process.env;
try {
  const { dbPath, dataDir, warnings } = resolveDataPaths(env); // throws if the DB is off the volume
  for (const w of warnings) console.warn(JSON.stringify({ level: 'warn', msg: w }));
  const db = await openDb(dbPath);
  const opts = { db, env, dataDir, port: portFromEnv(env) };
  if (env.CF_MULTIPLAYER === '1') await startMultiplayerServer({ ...opts, serverOpts: { handleSignals: true } });
  else await startServer({ ...opts, handleSignals: true });
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: err.message }));
  process.exit(1);
}
