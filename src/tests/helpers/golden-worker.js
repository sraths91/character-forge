/**
 * M64 H2 — worker_thread entry: runs golden scenarios in a fresh isolate
 * (fresh module state) so module-level counters cannot hide.
 * workerData: { names: string[] } → posts { results: {name: result} } or { error }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { installTripwires } from './tripwires.js';

installTripwires();
try {
  const { loadScenario, runScenario } = await import('./golden-runner.js');
  const results = {};
  for (const name of workerData.names) results[name] = await runScenario(loadScenario(name));
  parentPort.postMessage({ results });
} catch (err) {
  parentPort.postMessage({ error: String(err?.stack || err) });
}
