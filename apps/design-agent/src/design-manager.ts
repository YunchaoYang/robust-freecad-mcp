import crypto from "node:crypto";
import { CadToolError } from "../../../packages/shared/errors.js";
import type { CadGateway } from "../../cad-gateway/src/gateway.js";
import {
  DEFAULT_DESIGN_OPTIONS,
  DesignAgent,
  newDesignWorkDir,
  resolveDesignModel,
  type DesignModel,
  type DesignOptions,
  type DesignRecord,
} from "./design-agent.js";

const DESIGN_ID_RE = /^dsn_[A-Za-z0-9_-]{16}$/;

/** Runs design agents asynchronously; records are owned by the principal that started them. */
export class DesignManager {
  private readonly runs = new Map<string, { owner: string; record: DesignRecord; agent: DesignAgent; done: Promise<void> }>();
  private modelPromise?: Promise<DesignModel | null>;
  private active = 0;

  constructor(
    private readonly gw: CadGateway,
    private readonly modelOverride?: DesignModel,
    private readonly maxConcurrent = 2,
  ) {}

  private model(): Promise<DesignModel | null> {
    if (this.modelOverride) return Promise.resolve(this.modelOverride);
    this.modelPromise ??= resolveDesignModel().catch((e: unknown) => {
      this.modelPromise = undefined;
      throw e;
    });
    return this.modelPromise;
  }

  async start(principal: string, request: string, opts: Partial<DesignOptions> = {}): Promise<DesignRecord> {
    if (this.active >= this.maxConcurrent) throw new CadToolError("QUEUE_FULL", `At most ${this.maxConcurrent} design runs at once.`);
    const dm = await this.model();
    if (!dm) {
      throw new CadToolError(
        "DESIGN_UNAVAILABLE",
        "No model with credentials for the embedded pi agent. Log in once with `pi` (/login) or set FREECAD_MCP_DESIGN_MODEL=provider/id with that provider's API key in the server environment.",
      );
    }
    const id = `dsn_${crypto.randomBytes(12).toString("base64url")}`;
    // Drop undefined fields so they don't clobber defaults (MCP passes absent args as undefined).
    const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as Partial<DesignOptions>;
    const o: DesignOptions = { ...DEFAULT_DESIGN_OPTIONS, ...defined };
    const record: DesignRecord = {
      id,
      status: "running",
      request,
      model: `${dm.model.provider}/${dm.model.id}`,
      iterations: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      durationMs: 0,
      events: [],
    };
    const agent = new DesignAgent(this.gw, principal, dm, record, o, newDesignWorkDir(this.gw.cfg.dataDir, id));
    this.active++;
    const done = agent.run().finally(() => {
      this.active--;
    });
    this.runs.set(id, { owner: principal, record, agent, done });
    return record;
  }

  get(principal: string, id: string): DesignRecord {
    const r = DESIGN_ID_RE.test(id) ? this.runs.get(id) : undefined;
    if (!r || r.owner !== principal) throw new CadToolError("NOT_FOUND", "Unknown design id.");
    return r.record;
  }

  async wait(principal: string, id: string, timeoutMs: number): Promise<DesignRecord> {
    const rec = this.get(principal, id);
    const run = this.runs.get(id)!;
    await Promise.race([run.done, new Promise((r) => setTimeout(r, Math.max(0, timeoutMs)).unref())]);
    return rec;
  }

  cancel(principal: string, id: string): DesignRecord {
    const rec = this.get(principal, id);
    if (rec.status === "running") this.runs.get(id)!.agent.abort("cancelled");
    return rec;
  }

  async close(): Promise<void> {
    for (const r of this.runs.values()) if (r.record.status === "running") r.agent.abort("cancelled");
    await Promise.allSettled([...this.runs.values()].map((r) => r.done));
  }
}
