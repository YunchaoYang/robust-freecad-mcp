#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import { CadGateway } from "../../cad-gateway/src/gateway.js";
import type { GatewayConfig } from "../../cad-gateway/src/config.js";
import { registerArtifacts } from "./tools/artifacts.js";
import { registerDesign } from "./tools/design.js";
import { DesignManager } from "../../design-agent/src/design-manager.js";
import type { DesignModel } from "../../design-agent/src/design-agent.js";
import { registerExecute } from "./tools/execute.js";
import { registerJobStatus } from "./tools/job-status.js";
import { registerSearch } from "./tools/search.js";
import { connectStdio } from "./transport/stdio.js";

export const SERVER_NAME = "robust-freecad";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  /** Register the `design` tool (embedded pi agent). Default: FREECAD_MCP_DESIGN=1. */
  enableDesign?: boolean;
  /** Inject a model (tests use pi's faux provider). */
  designModel?: DesignModel;
}

export function createServer(
  overrides: Partial<GatewayConfig> = {},
  opts: ServerOptions = {},
): { server: McpServer; gateway: CadGateway; designs?: DesignManager } {
  const gateway = new CadGateway(overrides);
  const principal = gateway.cfg.principal;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "FreeCAD Code Mode server. Workflow: (1) `search` the curated catalog for relevant APIs/examples (fetch one with {id}); " +
        "(2) write FreeCAD Python that defines `doc` and `result_obj`; (3) `execute` a short JS program that calls " +
        "cad.submit({script, scriptLanguage:'freecad-python', outputs:['FCStd','STEP'], validation:{...}}) and cad.wait(id); " +
        "(4) on failure read error.code/hint, `checks` (expected vs actual) or traceback, fix the script and resubmit (bounded retries); " +
        "(5) fetch outputs with `artifacts`. Always state expected dimensions in `validation` so the server can verify them.",
    },
  );
  registerSearch(server, gateway);
  registerExecute(server, gateway, principal);
  registerJobStatus(server, gateway, principal);
  registerArtifacts(server, gateway, principal);
  let designs: DesignManager | undefined;
  if (opts.enableDesign ?? process.env.FREECAD_MCP_DESIGN === "1") {
    designs = new DesignManager(gateway, opts.designModel);
    registerDesign(server, gateway, designs, principal);
  }
  return { server, gateway, designs };
}

async function main(): Promise<void> {
  const { server, gateway, designs } = createServer();
  const shutdown = async () => {
    await designs?.close();
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  await connectStdio(server);
  process.stderr.write(`[${SERVER_NAME}] ready (python=${gateway.cfg.pythonPath}, data=${gateway.cfg.dataDir})\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
