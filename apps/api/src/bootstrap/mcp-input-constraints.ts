import type { McpOptions } from '@rekog/mcp-nest';
import { PROJECT_NAME_MAX_LENGTH } from '@platform/contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Zod v3's MCP reflection omits custom code-point refinements. */
function applyProjectNameConstraint(result: unknown): void {
  if (!isRecord(result) || !Array.isArray(result.tools)) return;
  for (const tool of result.tools) {
    if (!isRecord(tool) || tool.name !== 'create_project' || !isRecord(tool.inputSchema)) continue;
    const properties = tool.inputSchema.properties;
    if (!isRecord(properties) || !isRecord(properties.name)) continue;
    if (properties.name.type === 'string') properties.name.maxLength = PROJECT_NAME_MAX_LENGTH;
  }
}

/**
 * Use the framework's public server hook before it installs its handlers. Only
 * the advertised create_project name limit changes; authorization, discovery,
 * runtime validation and all other request handlers remain the framework's.
 */
export const withMcpInputConstraints: NonNullable<McpOptions['serverMutator']> = (mcp) => {
  const register = mcp.server.setRequestHandler.bind(mcp.server);
  mcp.server.setRequestHandler = (schema, handler) => {
    register(schema, async (request, extra) => {
      const result = await handler(request, extra);
      if (isRecord(request) && request.method === 'tools/list') applyProjectNameConstraint(result);
      return result;
    });
  };
  return mcp;
};
