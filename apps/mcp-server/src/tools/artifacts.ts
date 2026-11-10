import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CadToolError } from "../../../../packages/shared/errors.js";
import type { CadGateway } from "../../../cad-gateway/src/gateway.js";
import { guarded, jsonResult } from "./common.js";

export function registerArtifacts(server: McpServer, gw: CadGateway, principal: string): void {
  server.registerTool(
    "artifacts",
    {
      title: "List or fetch CAD artifacts",
      description:
        "Lists a completed job's validated artifacts (FCStd/STEP/STL) with size and sha256. With `artifactId`, returns a " +
        "download reference: an MCP resource URI (freecad-artifact://<job>/<artifact>, readable via resources/read) and, " +
        "for local stdio deployments, a file:// URI. Set `includeContent` to embed the file (base64, size-capped). " +
        "Artifacts are addressed only by server-issued ids, never by paths.",
      inputSchema: {
        jobId: z.string().max(64),
        artifactId: z.string().max(64).optional(),
        includeContent: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(() => {
        if (!args.artifactId) {
          const list = gw.artifacts(principal, args.jobId);
          const st = gw.status(principal, args.jobId);
          return jsonResult({ jobId: args.jobId, status: st.status, artifacts: list, note: list.length ? undefined : "No artifacts: job not completed or validation failed." });
        }
        const { info, file, mimeType } = gw.artifactFile(principal, args.jobId, args.artifactId);
        const meta = { ...info, mimeType, fileUri: pathToFileURL(file).href };
        if (!args.includeContent) return jsonResult(meta);
        if (info.sizeBytes > gw.cfg.maxInlineArtifactBytes) {
          throw new CadToolError("OUTPUT_TOO_LARGE", `Artifact is ${info.sizeBytes} bytes; inline limit is ${gw.cfg.maxInlineArtifactBytes}. Use fileUri or resources/read.`);
        }
        const data = fs.readFileSync(file).toString("base64");
        if (info.format === "PNG") {
          // Let the model actually see the render.
          return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "image", data, mimeType }] };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(meta) },
            { type: "resource", resource: { uri: info.resourceUri, mimeType, blob: data } },
          ],
        };
      }),
  );

  server.registerResource(
    "cad-artifact",
    new ResourceTemplate("freecad-artifact://{jobId}/{artifactId}", { list: undefined }),
    { title: "CAD job artifact", description: "Validated FCStd/STEP/STL output of a CAD job." },
    async (uri, vars) => {
      const jobId = String(vars.jobId);
      const artifactId = String(vars.artifactId);
      const { info, file, mimeType } = gw.artifactFile(principal, jobId, artifactId);
      if (info.sizeBytes > gw.cfg.maxInlineArtifactBytes) {
        throw new CadToolError("OUTPUT_TOO_LARGE", `Artifact is ${info.sizeBytes} bytes; limit ${gw.cfg.maxInlineArtifactBytes}.`);
      }
      return { contents: [{ uri: uri.href, mimeType, blob: fs.readFileSync(file).toString("base64") }] };
    },
  );
}
