import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CadGateway } from "../../../cad-gateway/src/gateway.js";
import { guarded, jsonResult } from "./common.js";

export function registerJobStatus(server: McpServer, gw: CadGateway, principal: string): void {
  server.registerTool(
    "job_status",
    {
      title: "Get CAD job status",
      description:
        "Returns the job state (queued|running|completed|failed|cancelled), geometry, validation checks (expected vs actual), " +
        "artifact list and a structured error with hint. Optionally waits up to `waitMs` for completion, includes the " +
        "status-transition log, or a bounded tail of worker logs. Set `cancel: true` to cancel a queued/running job.",
      inputSchema: {
        jobId: z.string().max(64),
        waitMs: z.number().int().min(0).max(60_000).optional().describe("Long-poll up to this many ms for a terminal state."),
        includeEvents: z.boolean().optional(),
        includeLogs: z.enum(["build", "verify"]).optional().describe("Append the stderr tail (<=4 KB) of this worker phase."),
        cancel: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        if (args.cancel) gw.cancel(principal, args.jobId);
        if (args.waitMs) await gw.wait(principal, args.jobId, args.waitMs);
        const status: Record<string, unknown> = { ...gw.status(principal, args.jobId, { includeEvents: args.includeEvents }) };
        if (args.includeLogs) status.logs = gw.logs(principal, args.jobId, { phase: args.includeLogs, stream: "stderr", maxBytes: 4000 });
        return jsonResult(status, status.status === "failed");
      }),
  );
}
