import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Response } from 'express';

/** docs/backend/02 §5.3 still promises legacy SSE alongside streamable HTTP.
 * Keep this installed SDK compatibility boundary out of business/RPC validation. */
export function createLegacyMcpServer() {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK 1.30.0 marks its low-level Server deprecated; the existing discovery/dispatch and legacy SSE protocol remain required by 02 §5.3.
  return new Server(
    { name: 'agent-platform-mcp', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
}
export function createLegacySseTransport(endpoint: string, response: Response) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK 1.30.0 deprecates SSEServerTransport, but 02 §5.3 explicitly retains this backward-compatible transport.
  return new SSEServerTransport(endpoint, response);
}
