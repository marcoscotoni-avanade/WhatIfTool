import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { parseProject } from '@planner/domain';
import { PlannerService, snapshot, type Actor } from './planner';
import { ServiceError } from './contracts';
import { FileProjectRepository } from './repository';

export interface ServerOptions {
  directory: string; uiToken: string; agentToken: string; port?: number;
  origins?: string[];
}
function equalToken(value: string, token: string) {
  const a = Buffer.from(value), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ServiceError(415, 'CONTENT_TYPE', 'Use application/json.');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 8 * 1024 * 1024) throw new ServiceError(413, 'TOO_LARGE', 'Request exceeds 8 MiB.');
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(400, 'INVALID_JSON', 'Invalid JSON request.'); }
}
function send(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}
let activeCalculations = 0;
async function calculate(data: unknown): Promise<unknown> {
  if (activeCalculations >= 2) throw new ServiceError(429, 'CALCULATION_BUSY', 'Two calculations are already running. Retry shortly.');
  activeCalculations++;
  try { return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: data });
    const timer = setTimeout(() => { void worker.terminate(); reject(new ServiceError(504, 'CALCULATION_TIMEOUT', 'Calculation exceeded 60 seconds.')); }, 60_000);
    worker.once('message', (message: { result?: unknown; error?: string }) => {
      clearTimeout(timer);
      if (message.error) reject(new ServiceError(422, 'CALCULATION_ERROR', message.error)); else resolve(message.result);
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Calculation worker exited with code ${code}.`)); });
  }); } finally { activeCalculations--; }
}
export async function createPlannerServer(options: ServerOptions) {
  if (typeof options.uiToken !== 'string' || typeof options.agentToken !== 'string'
    || options.uiToken.length < 20 || options.agentToken.length < 20 || options.uiToken === options.agentToken)
    throw new Error('Distinct UI and agent credentials of at least 20 characters are required.');
  const repository = new FileProjectRepository(options.directory);
  await repository.initialize();
  const service = new PlannerService(repository);
  const origins = new Set(options.origins ?? ['http://127.0.0.1:1420', 'http://127.0.0.1:1421', 'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']);
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port ?? 1430;
      if (request.headers.host !== `127.0.0.1:${port}`) throw new ServiceError(403, 'HOST', 'Invalid service host.');
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new ServiceError(403, 'ORIGIN', 'Origin is not allowed.');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const actor: Actor = equalToken(token, options.uiToken) ? 'ui' : equalToken(token, options.agentToken) ? 'agent'
        : (() => { throw new ServiceError(401, 'UNAUTHORIZED', 'A valid bearer token is required.'); })();
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/api/health' && request.method === 'GET') { send(response, { status: 'ready', protocol: 1 }); return; }
      if (url.pathname === '/api/projects') {
        if (request.method === 'GET') { send(response, await repository.list()); return; }
        if (request.method === 'POST') {
          if (actor !== 'ui') throw new ServiceError(403, 'FORBIDDEN', 'Only the UI may register a project.');
          const input = z.object({ model: z.unknown(), operationId: z.string().min(1) }).strict().parse(await body(request));
          let model: ReturnType<typeof parseProject>;
          try { model = parseProject(input.model); }
          catch (error) { throw new ServiceError(422, 'VALIDATION', error instanceof Error ? error.message : 'Invalid project document.'); }
          send(response, await service.register(model)); return;
        }
      }
      const match = /^\/api\/projects\/([\w-]{1,128})(?:\/(.*))?$/.exec(url.pathname);
      if (!match) throw new ServiceError(404, 'NOT_FOUND', 'Route not found.');
      const id = match[1]!, route = match[2] ?? '';
      if (!route && request.method === 'GET') { send(response, snapshot(await service.get(id))); return; }
      if (route === 'commands' && request.method === 'POST') { send(response, await service.execute(id, await body(request), actor)); return; }
      if (route === 'preview' && request.method === 'POST') { send(response, await service.preview(id, await body(request), actor)); return; }
      if (route === 'events' && request.method === 'GET') {
        const record = await service.get(id);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const emit = (revision: number) => response.write(`event: project.changed\ndata: ${JSON.stringify({ projectId: id, revision })}\n\n`);
        streams.add(response);
        emit(record.revision);
        const unsubscribe = service.subscribe(id, revision => { emit(revision); });
        const timer = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
        response.on('close', () => { clearInterval(timer); unsubscribe(); streams.delete(response); });
        return;
      }
      if (route === 'operations' && request.method === 'GET') {
        const record = await service.get(id);
        send(response, record.approvals.map(op => ({ ...op, status: op.status === 'pending' && Date.parse(op.expiresAt) < Date.now() ? 'expired' : op.status })));
        return;
      }
      const operation = /^operations\/([\w-]+)(\/decision)?$/.exec(route);
      if (operation) {
        if (operation[2] && request.method === 'POST') {
          if (actor !== 'ui') throw new ServiceError(403, 'FORBIDDEN', 'Agent credentials cannot approve operations.');
          const input = z.object({ approve: z.boolean() }).strict().parse(await body(request));
          send(response, await service.decide(id, operation[1]!, input.approve)); return;
        }
        if (!operation[2] && request.method === 'GET') {
          const found = (await service.get(id)).approvals.find(op => op.id === operation[1]);
          if (!found) throw new ServiceError(404, 'NOT_FOUND', 'Operation not found.');
          send(response, { ...found, status: found.status === 'pending' && Date.parse(found.expiresAt) < Date.now() ? 'expired' : found.status }); return;
        }
      }
      if (['calculate', 'compare'].includes(route) && request.method === 'POST') {
        const input = z.object({ scenarioId: z.string().optional(), milestoneId: z.string().optional() }).strict().parse(await body(request));
        const record = await service.get(id);
        const result = await calculate({ model: record.model, ...input, compare: route === 'compare' });
        send(response, { revision: record.revision, [route === 'compare' ? 'comparison' : 'results']: result }); return;
      }
      if (route === 'export' && request.method === 'GET') {
        if (url.searchParams.get('format') !== 'json') throw new ServiceError(400, 'FORMAT', 'Only JSON export is supported.');
        const model = (await service.get(id)).model;
        if (Buffer.byteLength(JSON.stringify(model), 'utf8') > 1024 * 1024)
          throw new ServiceError(413, 'EXPORT_TOO_LARGE', 'MCP JSON export exceeds 1 MiB. Use the UI export or paginated activity tools.');
        send(response, model); return;
      }
      throw new ServiceError(404, 'NOT_FOUND', 'Route not found.');
    })().catch(error => {
      const known = error instanceof ServiceError, invalid = error instanceof z.ZodError;
      console.error('[planner-service]', known ? error.code : invalid ? 'INVALID_INPUT' : 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
      if (!response.headersSent) send(response, {
        error: known || invalid ? error.message : 'Service operation failed. See the service error log.',
        code: known ? error.code : invalid ? 'INVALID_INPUT' : 'INTERNAL_ERROR',
      }, known ? error.status : invalid ? 400 : 500);
      else response.end();
    });
  });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000;
  return {
    server, service,
    listen: () => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 1430, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (typeof address !== 'object' || !address) { reject(new Error('Service address unavailable.')); return; }
        resolve(address.port);
      });
    }),
    close: () => new Promise<void>((resolve, reject) => {
      for (const stream of streams) stream.end();
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
