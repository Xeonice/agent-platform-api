import { McpTransportType, type McpOptions } from '@rekog/mcp-nest';

/**
 * MCP transport configuration (docs/backend/02 §6 Bootstrap).
 * The same Nest app instance exposes both Swagger (REST) and the MCP server,
 * sharing one singleton provider graph. Tools are discovered from any provider
 * carrying @Tool metadata (here: SandboxMcpTools), which inject the SAME
 * application services as the REST controllers.
 */
export const mcpModuleOptions: McpOptions = {
  name: 'agent-platform-mcp',
  version: '0.0.1',
  transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
};
