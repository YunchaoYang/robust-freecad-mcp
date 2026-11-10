// Print this server's tools/list exactly as an MCP client receives it (JSON on stdout).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/apps/mcp-server/src/server.js")],
  env: { ...process.env, FREECAD_MCP_DATA_DIR: process.env.FREECAD_MCP_DATA_DIR ?? path.join(root, "data") },
  stderr: "ignore",
});
const client = new Client({ name: "list-tools", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
process.stdout.write(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}), ...(t.annotations ? { annotations: t.annotations } : {}) }))));
await client.close();
