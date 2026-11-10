import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toStructuredError } from "../../../../packages/shared/errors.js";

export const MAX_RESPONSE_CHARS = 48_000;

/** Compact JSON text result, hard-capped so a tool can never flood the context. */
export function jsonResult(value: unknown, isError = false): CallToolResult {
  let text = JSON.stringify(value);
  if (text.length > MAX_RESPONSE_CHARS) {
    text = JSON.stringify({
      error: { code: "OUTPUT_TOO_LARGE", message: `Response truncated from ${text.length} chars.` },
      preview: text.slice(0, MAX_RESPONSE_CHARS - 500),
    });
    isError = true;
  }
  return { content: [{ type: "text", text }], isError };
}

export function errorResult(err: unknown): CallToolResult {
  return jsonResult({ error: toStructuredError(err) }, true);
}

export async function guarded(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return errorResult(e);
  }
}
