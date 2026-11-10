import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Local-development transport. stdout is reserved for MCP frames; all logs go to stderr. */
export async function connectStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
