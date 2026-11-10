/**
 * Shared contracts between the MCP server, Code Mode runtime, gateway and worker.
 * Zod schemas are the single source of truth; TypeScript types are inferred.
 */
import { z } from "zod";

export const OUTPUT_FORMATS = ["FCStd", "STEP", "STL", "PNG"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const posMm = z.number().positive().max(1e6);
const coordMm = z.number().min(-1e6).max(1e6);

export const HoleSpecSchema = z
  .object({
    diameterMm: posMm.describe("Expected hole diameter in mm."),
    centersMm: z
      .array(z.tuple([coordMm, coordMm]))
      .min(1)
      .max(64)
      .describe("Hole centres in the plane normal to `axis` (for axis z: [x, y])."),
    axis: z.enum(["x", "y", "z"]).default("z"),
    reference: z
      .enum(["bboxMin", "origin"])
      .default("bboxMin")
      .describe("bboxMin: centres measured from the part's bounding-box minimum corner; origin: absolute model coordinates."),
    through: z.boolean().default(true).describe("Require the hole to pass through the full part extent along `axis`."),
  })
  .strict();

export const MATERIALS = [
  "aluminum_6061", "steel", "stainless_304", "brass", "copper", "titanium",
  "abs", "pla", "petg", "nylon", "polycarbonate", "acetal",
] as const;

export const FlexTestSchema = z
  .object({
    name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_. -]+$/).optional(),
    set: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.union([z.number().finite(), z.string().max(64)]))
      .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 10, "1-10 spreadsheet aliases")
      .describe("Spreadsheet aliases in the FCStd to change, e.g. {length: 150} or {holeDiameter: '9 mm'}."),
    expect: z
      .object({
        boundingBoxMm: z.tuple([posMm, posMm, posMm]).optional(),
        volumeMm3: z.number().positive().optional(),
        holeCount: z.number().int().min(0).max(10000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ValidationSpecSchema = z
  .object({
    requireValidShape: z.boolean().default(true),
    requireSolid: z.boolean().default(true),
    expectedBoundingBoxMm: z.tuple([posMm, posMm, posMm]).optional().describe("[X, Y, Z] extents in mm."),
    toleranceMm: z.number().positive().max(10).optional().describe("Linear tolerance; default 0.01 mm."),
    expectedVolumeMm3: z.number().positive().optional(),
    volumeTolerancePct: z.number().positive().max(100).optional().describe("Default 0.5 %."),
    expectedSolidCount: z.number().int().min(0).max(10000).optional(),
    requireParametric: z
      .boolean()
      .optional()
      .describe("Require an editable feature tree (constrained sketches / expressions), not a baked shape."),
    holes: z.array(HoleSpecSchema).max(32).optional(),
    expectedHoleCount: z.number().int().min(0).max(10000).optional(),
    reportHoles: z.boolean().optional().describe("Include detected Z-axis holes in the result even without `holes`."),
    material: z.enum(MATERIALS).optional().describe("Report mass using this material's density."),
    maxMassG: z.number().positive().optional().describe("Fail if mass (requires `material`) exceeds this many grams."),
    requireFullyConstrained: z.boolean().optional().describe("Every sketch must have 0 remaining degrees of freedom."),
    flexTests: z
      .array(FlexTestSchema)
      .max(5)
      .optional()
      .describe("Re-open the FCStd, change spreadsheet parameters, recompute and check the model still rebuilds (requires FCStd output)."),
  })
  .strict()
  .refine((v) => v.maxMassG === undefined || v.material !== undefined, { message: "maxMassG requires material", path: ["maxMassG"] });

const paramKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const paramValue = z.union([z.number().finite(), z.string().max(256), z.boolean()]);

export const CadJobRequestSchema = z
  .object({
    script: z.string().min(1).max(200_000).describe("FreeCAD Python. Must define `doc` and `result_obj`."),
    scriptLanguage: z.literal("freecad-python"),
    outputs: z
      .array(z.enum(OUTPUT_FORMATS))
      .min(1)
      .max(3)
      .refine((a) => new Set(a).size === a.length, "outputs must be unique"),
    parameters: z
      .record(paramKey, paramValue)
      .refine((r) => Object.keys(r).length <= 64, "at most 64 parameters")
      .optional()
      .describe("Exposed to the script as the `params` dict."),
    validation: ValidationSpecSchema.default({ requireValidShape: true, requireSolid: true }),
    timeoutSec: z.number().int().min(5).max(600).optional(),
    idempotencyKey: z.string().min(1).max(128).optional().describe("Re-submitting with the same key returns the existing job."),
  })
  .strict()
  .refine((r) => !r.validation.flexTests?.length || r.outputs.includes("FCStd"), {
    message: "validation.flexTests requires 'FCStd' in outputs",
    path: ["validation", "flexTests"],
  });

export type FlexTest = z.infer<typeof FlexTestSchema>;
export type HoleSpec = z.infer<typeof HoleSpecSchema>;
export type ValidationSpec = z.infer<typeof ValidationSpecSchema>;
export type CadJobRequest = z.infer<typeof CadJobRequestSchema>;
export type CadJobRequestInput = z.input<typeof CadJobRequestSchema>;

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);

export interface ValidationCheck {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

export interface GeometrySummary {
  valid: boolean;
  solidCount: number;
  volumeMm3: number;
  boundingBoxMm: [number, number, number];
  boundingBoxMinMm?: [number, number, number];
  faceCount?: number;
  shapeType?: string;
}

export interface ArtifactInfo {
  artifactId: string;
  name: string;
  format: OutputFormat;
  sizeBytes: number;
  sha256: string;
  resourceUri: string;
}

export interface CadError {
  code: string;
  message: string;
  hint?: string;
  traceback?: string;
  details?: unknown;
}

export interface CadJobResult {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  freecadVersion?: string;
  geometry?: GeometrySummary;
  checks?: ValidationCheck[];
  detectedHoles?: unknown[];
  featureErrors?: unknown[];
  featureTree?: {
    sketchConstraints: number;
    expressions: number;
    types: string[];
    sketches?: { name: string; dof: number | null; fullyConstrained: boolean | null }[];
  };
  massProperties?: {
    volumeMm3: number;
    areaMm2: number;
    centerOfMassMm: [number, number, number];
    material?: string;
    densityGcm3?: number;
    massG?: number;
  };
  preview?: { rendered: boolean; nonBlankFraction?: number };
  artifacts?: ArtifactInfo[];
  error?: CadError;
  sandbox?: { enforced: boolean; landlockAbi?: number | null };
}
