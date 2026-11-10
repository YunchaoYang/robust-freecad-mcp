"""Measure the context cost of MCP servers' tool definitions (what a client must load up front).

    uv run --with mcp --with tiktoken python scripts/measure_tool_tokens.py [--out docs/data/tool_tokens.json]

Each server is started over stdio with a scrubbed environment, sent `initialize` +
`tools/list`, and the tool definitions (name, description, inputSchema) are serialised
exactly as a client would forward them. Token counts use tiktoken's o200k_base as a
tokenizer-neutral proxy (Claude's tokenizer is not public offline); bytes are exact.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
ENV_BIN = Path.home() / "micromamba" / "envs" / "freecad-mcp" / "bin"
UVX = os.environ.get("UVX", str(Path.home() / ".local" / "bin" / "uvx"))

SERVERS = {
    # name: (command, args, notes)
    "robust-freecad-mcp (ours)": (str(ENV_BIN / "node"), [str(ROOT / "dist/apps/mcp-server/src/server.js")], "this repo"),
    "neka-nat/freecad-mcp": (UVX, ["freecad-mcp"], "PyPI freecad-mcp"),
    "spkane/freecad-robust-mcp": (UVX, ["--from", "freecad-robust-mcp", "freecad-mcp"], "PyPI freecad-robust-mcp"),
    "dcc-mcp/dcc-mcp-freecad": (UVX, ["dcc-mcp-freecad"], "PyPI dcc-mcp-freecad"),
    "pzfreo/build123d-mcp": (UVX, ["build123d-mcp"], "PyPI build123d-mcp"),
    "CadQuery/cadquery-mcp": (UVX, ["cadquery-mcp"], "PyPI cadquery-mcp"),
}


def scrubbed_env() -> dict:
    keep = {"PATH": f"{ENV_BIN}:/usr/bin:/bin", "HOME": os.environ.get("MEASURE_HOME", os.environ["HOME"]),
            "LANG": "C.UTF-8", "UV_CACHE_DIR": os.environ.get("UV_CACHE_DIR", str(Path.home() / ".cache" / "uv"))}
    keep["FREECAD_MCP_PYTHON"] = str(ENV_BIN / "python")
    keep["FREECAD_MCP_DATA_DIR"] = os.environ.get("MEASURE_DATA", "/tmp/fc-measure-data")
    return keep


async def list_tools(cmd: str, args: list[str], timeout: float) -> list[dict]:
    params = StdioServerParameters(command=cmd, args=args, env=scrubbed_env())
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await asyncio.wait_for(s.initialize(), timeout)
            res = await asyncio.wait_for(s.list_tools(), timeout)
            out = []
            for t in res.tools:
                d = {"name": t.name, "description": t.description or "", "inputSchema": t.inputSchema}
                if getattr(t, "outputSchema", None):
                    d["outputSchema"] = t.outputSchema
                out.append(d)
            return out


def count(tools: list[dict]) -> dict:
    import tiktoken

    enc = tiktoken.get_encoding("o200k_base")
    blob = json.dumps(tools, ensure_ascii=False, separators=(",", ":"))
    return {"tools": len(tools), "bytes": len(blob.encode()), "tokens": len(enc.encode(blob)),
            "names": [t["name"] for t in tools]}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "docs" / "data" / "tool_tokens.json"))
    ap.add_argument("--timeout", type=float, default=240)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    results = {}
    for name, (cmd, args, notes) in SERVERS.items():
        if a.only and not any(o in name for o in a.only):
            continue
        try:
            tools = await asyncio.wait_for(list_tools(cmd, args, a.timeout), a.timeout + 30)
            results[name] = {**count(tools), "source": notes}
            print(f"{name:34s} tools={results[name]['tools']:4d} tokens={results[name]['tokens']:7d}", file=sys.stderr)
        except BaseException as exc:  # noqa: BLE001
            results[name] = {"error": f"{type(exc).__name__}: {str(exc)[:300]}", "source": notes}
            print(f"{name:34s} ERROR {results[name]['error'][:150]}", file=sys.stderr)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps({"measuredAt": __import__("datetime").date.today().isoformat(),
                                       "tokenizer": "tiktoken o200k_base (proxy)", "servers": results}, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
