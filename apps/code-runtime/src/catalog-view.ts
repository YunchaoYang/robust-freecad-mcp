import { CadToolError } from "../../../packages/shared/errors.js";
import type { Catalog, CatalogEntry } from "../../cad-gateway/src/catalog.js";

/** Concise catalog views shared by the `search` MCP tool and cad.search(). */

function brief(e: CatalogEntry) {
  return {
    id: e.id,
    title: e.title,
    module: e.module,
    kind: e.kind,
    tags: e.tags,
    freecadVersions: e.freecadVersions,
    summary: typeof e.summary === "string" ? e.summary.slice(0, 400) : undefined,
    signature: typeof e.signature === "string" ? e.signature.slice(0, 300) : undefined,
    hasExample: Boolean(e.example),
    limitations: Array.isArray(e.limitations) ? e.limitations.slice(0, 3) : undefined,
  };
}

export function searchCatalog(
  catalog: Catalog,
  q: { query: string; module?: string; kind?: string; tags?: string[]; limit?: number },
): { results: ReturnType<typeof brief>[]; total: number; contract: string; next: string } {
  const all = catalog.all();
  if (/\bcontract\b/i.test(q.query)) {
    const full = catalog.contractFull();
    if (full) {
      return {
        results: catalog.search(q.query, q).map((h) => brief(h.entry)),
        total: all.length,
        contract: full,
        next: "Use example(id) for a full worked script.",
      };
    }
  }
  const hits = catalog.search(q.query, q);
  return {
    results: hits.map((h) => brief(h.entry)),
    total: all.length,
    contract: catalog.contractSummary(),
    next: hits.length
      ? "Fetch full details + example source with search {id} (MCP) or cad.example(id) (Code Mode)."
      : all.length
        ? "No match; try broader keywords (e.g. 'pad', 'pocket', 'hole', 'sketch', 'boolean', 'fillet')."
        : "The catalog is empty or not installed.",
  };
}

export function getCatalogEntry(catalog: Catalog, id: string): CatalogEntry & { exampleSource?: string } {
  const e = catalog.get(id);
  if (!e) throw new CadToolError("NOT_FOUND", `No catalog entry '${id}'. Use search to list ids.`);
  const src = catalog.exampleSource(e);
  return src ? { ...e, exampleSource: src } : { ...e };
}
