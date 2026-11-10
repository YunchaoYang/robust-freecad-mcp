import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CadGateway } from "../../../cad-gateway/src/gateway.js";
import type { DesignRecord } from "../../../design-agent/src/design-agent.js";
import type { DesignManager } from "../../../design-agent/src/design-manager.js";
import { guarded, jsonResult } from "./common.js";

/** Client-facing view: events trimmed, final render attached once the design succeeds. */
function view(gw: CadGateway, principal: string, r: DesignRecord, includeEvents: boolean) {
  const { events, ...rest } = r;
  const body = { ...rest, events: includeEvents ? events : events.slice(-5) };
  const images: ImageContent[] = [];
  const png = r.result?.artifacts?.find((a) => a.format === "PNG");
  if (r.status === "succeeded" && r.jobId && png) {
    try {
      const { file } = gw.artifactFile(principal, r.jobId, png.id);
      images.push({ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" });
    } catch {
      /* artifact expired */
    }
  }
  return { body, images };
}

export function registerDesign(server: McpServer, gw: CadGateway, designs: DesignManager, principal: string): void {
  server.registerTool(
    "design",
    {
      title: "Design a part from plain English (embedded agent)",
      description:
        "Hands a plain-English part request to the server's embedded pi agent. It (1) derives an acceptance spec that the " +
        "server locks, (2) builds the part through Code Mode until every locked check passes, (3) has the render visually reviewed. " +
        "Start with {request}; the call returns {id, status} (and waits up to waitMs). Poll with {designId, waitMs}; cancel with " +
        "{designId, cancel:true}. On success the result holds the job id, compact checks, artifacts and the render as an image. " +
        "Budgets: maxIterations Code Mode calls, budgetUsd model spend.",
      inputSchema: {
        request: z.string().min(3).max(4000).optional(),
        designId: z.string().max(64).optional(),
        waitMs: z.number().int().min(0).max(600_000).optional().describe("Wait up to this long for completion (default 0)."),
        maxIterations: z.number().int().min(1).max(8).optional(),
        budgetUsd: z.number().positive().max(20).optional(),
        visualCheck: z.boolean().optional(),
        includeEvents: z.boolean().optional(),
        cancel: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guarded(async () => {
        let rec: DesignRecord;
        if (args.designId) {
          rec = args.cancel ? designs.cancel(principal, args.designId) : designs.get(principal, args.designId);
        } else if (args.request) {
          rec = await designs.start(principal, args.request, {
            maxIterations: args.maxIterations,
            budgetUsd: args.budgetUsd,
            visualCheck: args.visualCheck,
          });
        } else {
          return jsonResult({ error: { code: "INVALID_REQUEST", message: "Pass `request` to start or `designId` to poll." } }, true);
        }
        if (args.waitMs && rec.status === "running") rec = await designs.wait(principal, rec.id, args.waitMs);
        const { body, images } = view(gw, principal, rec, args.includeEvents === true);
        const res = jsonResult(body, rec.status === "failed" || rec.status === "budget_exhausted");
        res.content.push(...images);
        return res;
      }),
  );
}
