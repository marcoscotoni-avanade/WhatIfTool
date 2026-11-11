import { mkdir, readFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { atomicJson } from './repository';
import { createPlannerServer } from './server';

const directory = process.env.PLANNER_DATA_DIR ?? join(homedir(), '.whatiftool');
await mkdir(directory, { recursive: true, mode: 0o700 });
const lockPath = join(directory, 'service.lock');
try {
  const previous = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
  let running = true;
  try { process.kill(previous.pid, 0); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') running = false;
    else throw error;
  }
  if (running) throw new Error('A planner service is already running for this data directory.');
  await rm(lockPath);
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const lock = await open(lockPath, 'wx', 0o600);
await lock.writeFile(JSON.stringify({ pid: process.pid }));
const configPath = process.env.PLANNER_CONNECTION_FILE ?? join(directory, 'connection.json');
let credentials: { uiToken: string; agentToken: string };
try { credentials = JSON.parse(await readFile(configPath, 'utf8')) as typeof credentials; }
catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  credentials = { uiToken: randomBytes(32).toString('hex'), agentToken: randomBytes(32).toString('hex') };
}
const port = Number(process.env.PLANNER_SERVICE_PORT ?? 1430);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PLANNER_SERVICE_PORT.');
let closing = false;
const app = await createPlannerServer({ directory: join(directory, 'projects'), ...credentials, port });
try {
  await app.listen();
  await atomicJson(configPath, { url: `http://127.0.0.1:${port}`, ...credentials });
  console.error(`Planner service ready at http://127.0.0.1:${port}. Connection credentials: ${configPath} (keep private).`);
} catch (error) {
  await lock.close(); await rm(lockPath, { force: true }); throw error;
}
const stop = () => {
  if (closing) return;
  closing = true;
  void app.close().then(async () => { await lock.close(); await rm(lockPath, { force: true }); })
    .catch(error => { console.error('[planner-service] Shutdown failed', error); process.exitCode = 1; });
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
