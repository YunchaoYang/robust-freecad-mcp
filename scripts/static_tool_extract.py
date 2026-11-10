"""Statically estimate an MCP server's tool-definition payload from its Python source.

    python3 -I scripts/static_tool_extract.py <repo_dir> [--json]

Never imports or executes the target code: it parses files with `ast` and
reconstructs what FastMCP / the low-level SDK would advertise:
  * @<x>.tool(...) decorated functions -> name, docstring description,
    JSON-schema properties from parameters (type annotations + defaults);
  * Tool(name=..., description=..., inputSchema={...}) literals.
Test, example and archive directories are skipped. The result is an estimate
(runtime registration, conditional tools and dynamic schemas are not seen).
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

SKIP = ("test", "tests", "example", "examples", "archive", "docs", "scripts", ".github", "node_modules", "evals", "benchmark")
PY_TYPES = {"str": "string", "int": "integer", "float": "number", "bool": "boolean", "dict": "object", "list": "array",
            "Dict": "object", "List": "array", "Any": None}


def _ann_schema(ann) -> dict:
    if ann is None:
        return {}
    try:
        txt = ast.unparse(ann)
    except Exception:  # noqa: BLE001
        return {}
    base = txt.split("[")[0].split(".")[-1].replace("Optional", "").strip("[] ")
    for k, v in PY_TYPES.items():
        if txt.startswith(k) or base == k:
            return {"type": v} if v else {}
    if "Literal" in txt:
        try:
            vals = [ast.literal_eval(e) for e in ast.parse(txt).body[0].value.slice.elts]  # type: ignore[attr-defined]
            return {"enum": vals}
        except Exception:  # noqa: BLE001
            return {"type": "string"}
    if txt.startswith("Optional") or "|" in txt:
        inner = txt.replace("Optional[", "").split("|")[0].strip(" ]")
        return {"anyOf": [{"type": PY_TYPES.get(inner, "string")}, {"type": "null"}]}
    if "Annotated" in txt:
        return {"type": "string", "description": txt[:200]}
    return {"type": "object"}


def _is_tool_decorator(d) -> tuple[bool, dict]:
    node = d.func if isinstance(d, ast.Call) else d
    name = ast.unparse(node)
    if not (name.endswith(".tool") or name in ("tool", "mcp_tool") or name.endswith("register_tool")):
        return False, {}
    kw = {}
    if isinstance(d, ast.Call):
        for k in d.keywords:
            try:
                kw[k.arg] = ast.literal_eval(k.value)
            except Exception:  # noqa: BLE001
                pass
        if d.args:
            try:
                kw.setdefault("name", ast.literal_eval(d.args[0]))
            except Exception:  # noqa: BLE001
                pass
    return True, kw


def extract(repo: Path) -> list[dict]:
    tools: dict[str, dict] = {}
    for f in repo.rglob("*.py"):
        rel = f.relative_to(repo).parts
        if any(p.lower() in SKIP or p.lower().startswith("test") for p in rel[:-1]) or f.name.startswith("test_"):
            continue
        try:
            tree = ast.parse(f.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for d in node.decorator_list:
                    ok, kw = _is_tool_decorator(d)
                    if not ok:
                        continue
                    props, req = {}, []
                    args = node.args
                    defaults = [None] * (len(args.args) - len(args.defaults)) + list(args.defaults)
                    for a, dflt in zip(args.args, defaults):
                        if a.arg in ("self", "ctx", "context") or (a.annotation is not None and "Context" in ast.unparse(a.annotation)):
                            continue
                        sch = {"title": a.arg.replace("_", " ").title(), **_ann_schema(a.annotation)}
                        if dflt is not None:
                            try:
                                sch["default"] = ast.literal_eval(dflt)
                            except Exception:  # noqa: BLE001
                                pass
                        else:
                            req.append(a.arg)
                        props[a.arg] = sch
                    for a in args.kwonlyargs:
                        props[a.arg] = {"title": a.arg.title(), **_ann_schema(a.annotation)}
                    name = kw.get("name") or node.name
                    desc = kw.get("description") or ast.get_docstring(node) or ""
                    schema = {"type": "object", "properties": props, "required": req, "title": f"{node.name}Arguments"}
                    tools[name] = {"name": name, "description": desc, "inputSchema": schema, "_file": str(Path(*rel))}
            elif isinstance(node, ast.Call) and ast.unparse(node.func).split(".")[-1] == "Tool":
                kw = {}
                for k in node.keywords:
                    try:
                        kw[k.arg] = ast.literal_eval(k.value)
                    except Exception:  # noqa: BLE001
                        kw[k.arg] = None
                if isinstance(kw.get("name"), str):
                    tools[kw["name"]] = {"name": kw["name"], "description": kw.get("description") or "",
                                         "inputSchema": kw.get("inputSchema") or {"type": "object"}, "_file": str(Path(*rel))}
            elif isinstance(node, ast.Dict):
                # dict-literal tool tables: {"name": ..., "description": ..., "inputSchema": {...}}
                try:
                    keys = [ast.literal_eval(k) for k in node.keys if k is not None]
                except Exception:  # noqa: BLE001
                    continue
                if {"name", "description"} <= set(keys) and ("inputSchema" in keys or "input_schema" in keys):
                    try:
                        d = ast.literal_eval(node)
                    except Exception:  # noqa: BLE001
                        continue
                    if isinstance(d.get("name"), str):
                        tools[d["name"]] = {"name": d["name"], "description": d.get("description") or "",
                                            "inputSchema": d.get("inputSchema") or d.get("input_schema") or {}, "_file": str(Path(*rel))}
    return sorted(tools.values(), key=lambda t: t["name"])


def main() -> None:
    repo = Path(sys.argv[1])
    tools = extract(repo)
    payload = [{k: v for k, v in t.items() if not k.startswith("_")} for t in tools]
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    out = {"tools": len(payload), "bytes": len(blob.encode()), "names": [t["name"] for t in payload],
           "files": sorted({t["_file"] for t in tools})}
    print(json.dumps(out if "--json" not in sys.argv else {**out, "payload": payload}))


if __name__ == "__main__":
    main()
