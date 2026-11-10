import fs from "node:fs";
import path from "node:path";

/**
 * Append-only structured audit log (JSON lines) plus a mirror on stderr.
 * Never write to stdout: it carries the MCP stdio transport.
 */
export class AuditLog {
  private readonly file: string;

  constructor(dataDir: string, private readonly echo = process.env.FREECAD_MCP_LOG_STDERR !== "0") {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "audit.log");
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
    try {
      fs.appendFileSync(this.file, line + "\n");
    } catch {
      /* audit must never crash the server */
    }
    if (this.echo) process.stderr.write(line + "\n");
  }
}
