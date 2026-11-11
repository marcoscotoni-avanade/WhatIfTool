import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadPlannerConnection } from './config';
import { PlannerClient } from './client';
import { registerPlannerTools } from './tools';

async function main(): Promise<void> {
  const connection = await loadPlannerConnection();
  const server = new McpServer({ name: 'whatiftool-planner', version: '1.0.0' });
  registerPlannerTools(server, new PlannerClient(connection));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[mcp] WhatIfTool planner MCP server connected to ${new URL(connection.url).origin}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[mcp] startup failed: ${message}\n`);
  process.exitCode = 1;
});
