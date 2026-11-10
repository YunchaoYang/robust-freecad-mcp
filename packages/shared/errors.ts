/** Structured, actionable errors shared by every layer. */

export const ERROR_HINTS: Record<string, string> = {
  INVALID_REQUEST: "Fix the listed fields and resubmit. Use `search` with query 'job request contract' for the schema.",
  NOT_FOUND: "The job or artifact id is unknown, expired, or not owned by you.",
  FORBIDDEN: "You are not authorised for this job.",
  RATE_LIMITED: "Too many submissions; wait and retry, or reuse an existing job.",
  QUEUE_FULL: "Too many active jobs; wait for running jobs to finish or cancel some.",
  SCRIPT_SYNTAX_ERROR: "Fix the Python syntax error at the reported line.",
  SCRIPT_ERROR: "The FreeCAD script raised an exception; see traceback (job-script frames only).",
  SCRIPT_CONTRACT: "The script must define `doc` (App document) and `result_obj` (final object with .Shape).",
  RECOMPUTE_ERROR: "A feature failed to recompute; see featureErrors for the failing feature and its message.",
  EXPORT_FAILED: "Exporting an artifact failed; ensure result_obj.Shape is a valid solid.",
  VALIDATION_FAILED: "The geometry does not meet the validation spec; inspect `checks` (expected vs actual) and adjust the script.",
  TIMEOUT: "The job exceeded its wall-time budget; simplify geometry or raise timeoutSec (max 600).",
  CANCELLED: "The job was cancelled.",
  WORKER_CRASHED: "The FreeCAD process crashed (possibly an OCCT failure or memory limit). Simplify booleans or reduce feature count.",
  WORKER_INIT_FAILED: "The FreeCAD runtime could not start; check server configuration (FREECAD_MCP_PYTHON).",
  WORKER_INTERRUPTED: "The server restarted while the job was running; resubmit.",
  SANDBOX_UNAVAILABLE: "Kernel sandboxing (Landlock/seccomp) is unavailable; the operator must fix the host or explicitly opt out.",
  CODE_RUNTIME_ERROR: "Your JavaScript threw; see message/stack. Only the `cad` bridge and console are available.",
  BUDGET_EXCEEDED: "The Code Mode program exceeded a budget (time, memory, bridge calls or concurrency).",
  OUTPUT_TOO_LARGE: "Return a smaller value (e.g. ids and summaries instead of full results).",
  INTERNAL: "Unexpected server error.",
};

export class CadToolError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CadToolError";
    this.code = code;
    this.hint = ERROR_HINTS[code];
    this.details = details;
  }

  toJSON(): { code: string; message: string; hint?: string; details?: unknown } {
    const out: { code: string; message: string; hint?: string; details?: unknown } = { code: this.code, message: this.message };
    if (this.hint) out.hint = this.hint;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function toStructuredError(err: unknown): { code: string; message: string; hint?: string; details?: unknown } {
  if (err instanceof CadToolError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL", message, hint: ERROR_HINTS.INTERNAL };
}

/** Flatten zod issues into short "path: message" strings. */
export function formatZodIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.slice(0, 20).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}
