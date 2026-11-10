import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CadGateway } from "../../../cad-gateway/src/gateway.js";
import { getCatalogEntry, searchCatalog } from "../../../code-runtime/src/catalog-view.js";
import { runCodeMode } from "../../../code-runtime/src/sandbox.js";
import { guarded, jsonResult } from "./common.js";

export function registerSearch(server: McpServer, gw: CadGateway): void {
  server.registerTool(
    "search",
    {
      title: "Search FreeCAD API catalog",
      description:
        "Progressive discovery of the curated FreeCAD scripting catalog (Part, Sketcher, PartDesign, Spreadsheet, validation). " +
        "Pass `query` for ranked compact hits, or `id` to fetch one entry in full including its example script. " +
        "Every response includes the job script contract. Query 'contract' for the full contract.\n" +
        "Alternatively pass `code`: a read-only JS program run in the sandbox against\n" +
        "  declare const catalog: { version: string; freecadVersion: string; entries: Array<{ id: string; kind: 'contract'|'example'|'api'|'pitfall';\n" +
        "    title: string; module?: string; tags?: string[]; freecadVersions?: string[]; summary?: string; signature?: string;\n" +
        "    limitations?: string[]; hasExample: boolean }> };\n" +
        "e.g. `return catalog.entries.filter(e => e.kind === 'pitfall').map(e => [e.id, e.summary])` or\n" +
        "`return catalog.entries.filter(e => e.module === 'PartDesign' && e.tags?.includes('Pocket')).map(e => e.id)`.",
      inputSchema: {
        code: z.string().max(20_000).optional().describe("Read-only JS over `catalog` (see description). Returns its JSON result."),
        query: z.string().max(500).optional().describe("Keywords, e.g. 'pad sketch rectangle', 'through hole pocket', 'fillet edges'."),
        id: z.string().max(128).optional().describe("Catalog entry id for full details + example source."),
        kind: z.enum(["contract", "example", "api", "pitfall"]).optional(),
        module: z.string().max(64).optional().describe("Filter: Part | Sketcher | PartDesign | Spreadsheet | ..."),
        tags: z.array(z.string().max(64)).max(10).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        if (args.id) return jsonResult(getCatalogEntry(gw.catalog, args.id));
        if (args.code) {
          const meta = gw.catalog.meta();
          const entries = gw.catalog.all().map(({ example, ...e }) => ({ ...e, hasExample: Boolean(example) }));
          const out = await runCodeMode(args.code, {}, {
            principal: "catalog",
            limits: { wallTimeMs: 5000, maxBridgeCalls: 0, memoryBytes: 32 * 1024 * 1024 },
            globals: { catalog: { version: meta.version ?? null, freecadVersion: meta.freecadVersion ?? null, entries } },
          });
          return jsonResult(out, !out.ok);
        }
        return jsonResult(searchCatalog(gw.catalog, { query: args.query ?? "", kind: args.kind, module: args.module, tags: args.tags, limit: args.limit }));
      }),
  );
}
