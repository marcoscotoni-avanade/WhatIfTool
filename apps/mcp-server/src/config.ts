import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const connectionFileSchema = z.object({
  url: z.string().url().optional(),
  agentToken: z.string().min(1).optional(),
}).strip();

export interface PlannerConnection {
  url: string;
  agentToken: string;
}

export async function loadPlannerConnection(env: NodeJS.ProcessEnv = process.env): Promise<PlannerConnection> {
  const filePath = resolve(env.PLANNER_CONNECTION_FILE ?? resolve(homedir(), '.whatiftool', 'connection.json'));
  let fileConfig: z.infer<typeof connectionFileSchema> = {};

  if (!env.PLANNER_SERVICE_URL || !env.PLANNER_AGENT_TOKEN) {
    try {
      fileConfig = connectionFileSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Unable to read planner connection file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const url = env.PLANNER_SERVICE_URL ?? fileConfig.url ?? 'http://127.0.0.1:1430';
  const agentToken = env.PLANNER_AGENT_TOKEN ?? fileConfig.agentToken;
  const serviceUrl = loopbackServiceUrl(url);
  if (!agentToken?.trim()) {
    throw new Error(`Planner agent token is required. Set PLANNER_AGENT_TOKEN or configure agentToken in ${filePath}.`);
  }
  return { url: serviceUrl, agentToken };
}

export function loopbackServiceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PLANNER_SERVICE_URL must be http://127.0.0.1:<port>.');
  }
  const hostname = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535
    || parsed.username || parsed.password || (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    throw new Error('PLANNER_SERVICE_URL must be http://127.0.0.1:<port> without credentials, path, query, or fragment.');
  }
  return `http://127.0.0.1:${port}`;
}
