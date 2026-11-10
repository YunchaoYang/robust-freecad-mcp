import fs from "node:fs";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import type { CadGateway } from "../../../cad-gateway/src/gateway.js";
import { PREVIEW_MARKER } from "../../../code-runtime/src/cad-bridge.js";

export const MAX_PREVIEW_IMAGES = 3;
export const MAX_PREVIEW_BYTES = 1024 * 1024;

/**
 * Replace cad.preview() markers in a Code Mode result with a short note and
 * collect the referenced PNG artifacts as MCP image content. The program's output is
 * untrusted: a marker is only honoured if the gateway confirms the caller owns a PNG
 * artifact with that id, and the bytes come from the store, not from the program.
 */
export function attachPreviews(gw: CadGateway, principal: string, result: unknown): { value: unknown; images: ImageContent[] } {
  const images: ImageContent[] = [];
  const seen = new Map<string, number>();

  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 8 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    const o = v as Record<string, unknown>;
    const m = o[PREVIEW_MARKER] as { jobId?: unknown; artifactId?: unknown } | undefined;
    if (m && typeof m === "object" && typeof m.jobId === "string" && typeof m.artifactId === "string") {
      const key = `${m.jobId}/${m.artifactId}`;
      if (seen.has(key)) return { preview: `image #${seen.get(key)} (attached)`, jobId: m.jobId };
      if (images.length >= MAX_PREVIEW_IMAGES) return { preview: `not attached: at most ${MAX_PREVIEW_IMAGES} images per execute`, jobId: m.jobId };
      try {
        const { info, file, mimeType } = gw.artifactFile(principal, m.jobId, m.artifactId);
        if (info.format !== "PNG") return { preview: "not attached: not a PNG artifact", jobId: m.jobId };
        if (info.sizeBytes > MAX_PREVIEW_BYTES) return { preview: `not attached: ${info.sizeBytes} bytes > ${MAX_PREVIEW_BYTES}`, jobId: m.jobId };
        images.push({ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType });
        seen.set(key, images.length);
        return { preview: `image #${images.length} (attached): 2x2 views iso/top/front/right`, jobId: m.jobId };
      } catch {
        return { preview: "not attached: unknown preview", jobId: m.jobId };
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = visit(x, depth + 1);
    return out;
  };

  return { value: visit(result, 0), images };
}
