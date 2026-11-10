import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CadGateway } from "../../../cad-gateway/src/gateway.js";
import { BRIDGE_DOC, createBridge } from "../../../code-runtime/src/cad-bridge.js";
import { attachPreviews } from "./previews.js";
import { MAX_WALL_TIME_MS } from "../../../code-runtime/src/limits.js";
import { runCodeMode, type ExecuteOutcome } from "../../../code-runtime/src/sandbox.js";
import type { CallToolResult, ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { guarded, jsonResult } from "./common.js";

/** Attach response-size metrics (chars and ~tokens at 4 chars/token) so savings are measurable. */
function withTokenStats(out: ExecuteOutcome, images: ImageContent[], isError: boolean): CallToolResult {
  const body = { ...out, stats: { ...out.stats, responseChars: 0, approxTokens: 0, images: images.length } };
  const chars = JSON.stringify(body).length;
  body.stats.responseChars = chars;
  body.stats.approxTokens = Math.ceil(chars / 4);
  const res = jsonResult(body, isError);
  res.content.push(...images);
  return res;
}

export function registerExecute(server: McpServer, gw: CadGateway, principal: string): void {
  const bridge = createBridge(gw);
  server.registerTool(
    "execute",
    {
      title: "Run a Code Mode program against the CAD bridge",
      description:
        "Runs a JavaScript program in an isolated QuickJS sandbox. `code` is either an async function body " +
        "(use `return` for the result) or an `async () => {...}` expression. The return value must be JSON-serialisable " +
        "and small (<=32 KB); return ids and compact summaries, not whole files or scripts.\n" +
        BRIDGE_DOC,
      inputSchema: {
        code: z.string().min(1).max(200_000),
        timeoutMs: z.number().int().min(1000).max(MAX_WALL_TIME_MS).optional().describe("Wall-time budget, default 120000."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const out = await runCodeMode(args.code, bridge, { principal, limits: args.timeoutMs ? { wallTimeMs: args.timeoutMs } : {} });
        if (!out.ok) return withTokenStats(out, [], true);
        const { value, images } = attachPreviews(gw, principal, out.result);
        return withTokenStats({ ...out, result: value }, images, false);
      }),
  );
}
