/** Budgets for one Code Mode `execute` call. */
export interface ExecutionLimits {
  /** Total wall time for the program, including time spent awaiting the bridge. */
  wallTimeMs: number;
  /** QuickJS heap limit. */
  memoryBytes: number;
  /** QuickJS native stack limit. */
  stackBytes: number;
  /** Total `cad.*` calls allowed. */
  maxBridgeCalls: number;
  /** Bridge calls in flight at once (extra calls wait their turn). */
  maxConcurrentBridgeCalls: number;
  /** cad.submit calls allowed per execution. */
  maxSubmits: number;
  /** Max size of the JSON-serialised return value. */
  maxOutputBytes: number;
  /** Max bytes of captured console output. */
  maxLogBytes: number;
  /** Max size of any single bridge argument (JSON). */
  maxBridgeArgBytes: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  wallTimeMs: 120_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  maxBridgeCalls: 64,
  maxConcurrentBridgeCalls: 4,
  maxSubmits: 8,
  maxOutputBytes: 32 * 1024,
  maxLogBytes: 8 * 1024,
  maxBridgeArgBytes: 256 * 1024,
};

export const MAX_WALL_TIME_MS = 600_000;

export function resolveLimits(overrides: Partial<ExecutionLimits> = {}): ExecutionLimits {
  const l = { ...DEFAULT_LIMITS, ...overrides };
  l.wallTimeMs = Math.min(Math.max(l.wallTimeMs, 1000), MAX_WALL_TIME_MS);
  return l;
}

/** Simple async semaphore for bounded parallelism. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}
