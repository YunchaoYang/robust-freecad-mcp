import fs from "node:fs";
import path from "node:path";

export interface CatalogEntry {
  id: string;
  title: string;
  module?: string;
  kind?: string;
  tags?: string[];
  freecadVersions?: string[];
  summary?: string;
  signature?: string;
  example?: string; // file name under examples/
  limitations?: string[];
  [k: string]: unknown;
}

export interface SearchOptions {
  module?: string;
  kind?: string;
  tags?: string[];
  limit?: number;
}

const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "with", "and", "or", "for", "how", "do", "i", "make", "create"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_.:]+/)
    .flatMap((t) => (t.includes(".") || t.includes("::") ? [t, ...t.split(/[.:]+/)] : [t]))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Curated FreeCAD API catalog (Part, Sketcher, PartDesign, ...). Loaded lazily and
 * re-read when the file changes so catalog edits do not need a server restart.
 */
export class Catalog {
  private entries: CatalogEntry[] = [];
  private mtimeMs = -1;

  constructor(
    private readonly catalogPath: string,
    private readonly examplesDir: string,
    private readonly contractPath = path.join(path.dirname(catalogPath), "contract.md"),
  ) {}

  /** Catalog metadata (FreeCAD version the catalog was validated against). */
  meta(): { version?: unknown; freecadVersion?: unknown } {
    this.load();
    return this.metaInfo;
  }

  private metaInfo: { version?: unknown; freecadVersion?: unknown } = {};

  private load(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.catalogPath);
    } catch {
      this.entries = [];
      this.mtimeMs = -1;
      return;
    }
    if (st.mtimeMs === this.mtimeMs) return;
    const raw: unknown = JSON.parse(fs.readFileSync(this.catalogPath, "utf8"));
    const list = Array.isArray(raw) ? raw : ((raw as { entries?: unknown[] }).entries ?? []);
    if (!Array.isArray(raw)) {
      const r = raw as { version?: unknown; freecadVersion?: unknown };
      this.metaInfo = { version: r.version, freecadVersion: r.freecadVersion };
    }
    this.entries = (list as CatalogEntry[]).filter((e) => e && typeof e.id === "string" && typeof e.title === "string");
    this.mtimeMs = st.mtimeMs;
  }

  all(): CatalogEntry[] {
    this.load();
    return this.entries;
  }

  /** Compact one-paragraph script contract, always attached to search results. */
  contractSummary(): string {
    return (
      "Job script contract: FreeCAD Python runs headless (no FreeCADGui/ViewObject). Globals App/FreeCAD, Part, Sketcher, params " +
      "are pre-bound. Define `doc` (App.newDocument) and `result_obj` (final document object with .Shape, e.g. a PartDesign Body). " +
      "Submit via cad.submit({script, scriptLanguage:'freecad-python', outputs:['FCStd','STEP'], validation:{...}}); " +
      "geometry is validated from the re-imported exports. Search 'contract' for the full text."
    );
  }

  contractFull(): string | undefined {
    try {
      return fs.readFileSync(this.contractPath, "utf8").slice(0, 20_000);
    } catch {
      return undefined;
    }
  }

  search(query: string, opts: SearchOptions = {}): { entry: CatalogEntry; score: number }[] {
    this.load();
    const q = tokens(query);
    const wantTags = (opts.tags ?? []).map((t) => t.toLowerCase());
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
    const scored: { entry: CatalogEntry; score: number }[] = [];
    for (const e of this.entries) {
      if (opts.module && (e.module ?? "").toLowerCase() !== opts.module.toLowerCase()) continue;
      if (opts.kind && (e.kind ?? "").toLowerCase() !== opts.kind.toLowerCase()) continue;
      const etags = (e.tags ?? []).map((t) => t.toLowerCase());
      if (wantTags.length && !wantTags.every((t) => etags.includes(t))) continue;
      const fields: [string, number][] = [
        [e.id, 3],
        [e.title, 3],
        [etags.join(" "), 3],
        [e.signature ?? "", 2],
        [e.module ?? "", 1],
        [e.summary ?? "", 1],
      ];
      let score = 0;
      for (const t of q) {
        for (const [text, w] of fields) {
          const toks = tokens(text);
          if (toks.includes(t)) score += w;
          else if (toks.some((x) => x.startsWith(t) || (t.length > 3 && x.includes(t)))) score += w / 2;
        }
      }
      if (q.length === 0) score = 1; // pure filter query
      // Prefer short, vetted cadkit examples: fewer script tokens and they pass flexTests.
      else if (score > 0 && (e.module ?? "").toLowerCase() === "cadkit") score += e.kind === "example" ? 3 : 1.5;
      if (score > 0) scored.push({ entry: e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.slice(0, limit);
  }

  get(id: string): CatalogEntry | undefined {
    this.load();
    return this.entries.find((e) => e.id === id);
  }

  /** Read an example file by catalog name only (no client-supplied paths). */
  exampleSource(entry: CatalogEntry): string | undefined {
    if (!entry.example) return undefined;
    const base = path.basename(entry.example);
    if (base !== entry.example.replace(/^examples\//, "")) return undefined;
    const file = path.join(this.examplesDir, base);
    try {
      return fs.readFileSync(file, "utf8").slice(0, 40_000);
    } catch {
      return undefined;
    }
  }
}
