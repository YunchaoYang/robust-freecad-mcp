# FreeCAD MCP landscape and Code Mode tool design

*Researched 2026-11-06. Star counts and dates come from the GitHub API.*

## 1. Existing FreeCAD MCP servers

| Repo | ★ / last push | Architecture | Tools | Arbitrary Python | Isolation | Geometry validation | Images |
|---|---|---|---|---|---|---|---|
| [neka-nat/freecad-mcp](https://github.com/neka-nat/freecad-mcp) | ~3.2k / Oct 2026 | GUI addon; XML-RPC on :9875; FastMCP stdio client | 17 (create/edit/delete_object, get_view, execute_code ×3 modes, parts library, FEM, …) | yes (GUI thread, async, headless `freecadcmd`) | localhost + optional token/IP allowlist; "full privileges" | none ("script success does not certify geometry validity") | screenshot on most tools |
| [bonninr/freecad_mcp](https://github.com/bonninr/freecad_mcp) | ~228 / Mar 2025 | GUI workbench; JSON TCP :9876 | 2 (`get_scene_info`, `run_script`) | yes | none | none | no |
| [contextform/freecad-mcp](https://github.com/contextform/freecad-mcp) | ~139 / Aug 2025 | GUI workbench + socket bridge | 7, `*_operations` tools taking an op enum | yes | none | none | view_control |
| [blwfish/freecad-mcp](https://github.com/blwfish/freecad-mcp) | ~65 / Nov 2026 | Same workbench lineage; Unix sockets; can spawn headless instances | ~40 (sketch/partdesign/part/assembly/…_operations, lint, regression_check, api_introspection, poll_job, cancel_job, …) | yes, no timeout | "by design" full access | **strongest of the GUI servers**: OCCT validity, volume/bbox fixtures, lint, regression | yes |
| [sandraschi/freecad-mcp](https://github.com/sandraschi/freecad-mcp) | ~33 / Nov 2026 | FastMCP SSE/HTTP + REST + React dashboard | ~60 (README claim: CFD, FEM, BIM, slicer, …) | n/a | none stated | inspection only | web viewer |
| [CREATeNG/freecad-mcp-bridge](https://github.com/CREATeNG/freecad-mcp-bridge) | ~24 / Nov 2026 | Streamable-HTTP MCP inside FreeCAD | 3 (execute_python, execute_python_file, get_output_page) | yes, that is the whole design | loopback only | none | no |
| [dcc-mcp/dcc-mcp-freecad](https://github.com/dcc-mcp/dcc-mcp-freecad) | 2 / Oct 2026 | **Headless** `FreeCADCmd`; version matrix tested in CI | many typed tools + `run_script` (file path only) | restricted (allowed roots, safe mode, 300 s) | "not a sandbox" | read-back topology/volume/bbox + SHA-256 | headless PNG |
| [timianmalloo/freecad-headless-mcp](https://github.com/timianmalloo/freecad-headless-mcp) | 1 / May 2026 | headless subprocess | 3 (exec, export, inspect) | yes | 1 MB output cap | inspect | no |

### Where this project stands

| | Typical existing server | **freecad-codemode-mcp** |
|---|---|---|
| Runtime | live GUI session reached over a socket | headless FreeCAD 1.1.3, a fresh process per job |
| Untrusted Python | runs with the user's full privileges | Landlock (filesystem allowlist, TCP deny, signal/abstract-socket scoping) + seccomp (no sockets, exec or fork) + rlimits. Escapes are tested in `tests/cad`. |
| Validation | none, or opt-in tools | always on. It runs in a **separate process that executes no job code**, on the re-imported STEP/FCStd: validity, solids, bbox, volume, concave-hole positions, parametric feature tree |
| Results | screenshots and free text | structured `checks[{expected, actual, message}]` and actionable error codes (`featureErrors`, traceback limited to job-script frames) |
| Tool surface | 7–60 tools, growing with features | a few tools; the rest grows in the catalog and the typed `cad` bridge |
| Artifacts | the agent saves files itself | deterministic FCStd/STEP/STL, published only after validation, sha256, addressed by ID |

Gaps compared with the field:
- No rendered previews. neka-nat and dcc-mcp offer these; a headless PNG render could later become an optional artifact.
- No editing of a live, user-visible document. neka-nat's strength is iterating in an open GUI.
- No FEM, assemblies or parts library. Add these as catalog entries and bridge capabilities, not as new tools.

Ideas worth borrowing:
- blwfish's fixture/regression checks, and keeping errors short with a pointer to the full traceback.
- dcc-mcp's tested version matrix and its check that rendered images are not blank.

## 2. Cloudflare Code Mode (reference design)

Sources: [cloudflare/mcp](https://github.com/cloudflare/mcp), [build guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/), [Code Mode](https://blog.cloudflare.com/code-mode/), [Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/).

- **Two core tools cover about 2,500 API endpoints in roughly 1k tokens.** `search` and `execute` are the core; `docs` and `whoami` are minor extras. Defining one tool per endpoint would cost 244k–1.17M tokens.
- **`search` takes code, not keywords.** The agent submits an async arrow function, which runs read-only against a typed `spec` object (the resolved OpenAPI document). The tool description contains the `.d.ts` for that object plus three example queries.
- **`execute` runs code in a fresh isolate per call.** The only way out of the isolate is a binding, `cloudflare.request()`. Credentials are added outside the isolate, so the code "receives a request function, not the credential."
- **Results are truncated structurally at about 6k tokens.** The output stays valid JSON and carries "N more items" markers. Output from the sandbox is treated as untrusted and parsed as `{ok, result} | {ok:false, message}`.
- **Tool metadata is static and identical for every user**, because clients cache it. Annotations: `search` is read-only; `execute` is marked destructive.
- **New capabilities need no new tools.** The catalog and the bindings grow instead of the tool list.

## 3. Recommended tool organisation

Plan §3 lists four tools: `search`, `execute`, `job_status` and `artifacts`. Applying Code Mode more fully:

1. **Main path: `search` + `execute`.** Inside `execute`, one call should be enough to submit a job, wait for it, and read its geometry, checks and artifact IDs:
   ```js
   const job = await cad.submit({ script, scriptLanguage: "freecad-python", outputs: ["FCStd", "STEP"],
                                  validation: { expectedBoundingBoxMm: [120, 80, 10], requireParametric: true, holes: [...] } });
   const r = await cad.wait(job.id, { timeoutMs: 120000 });
   return { status: r.status, failed: r.checks?.filter(c => !c.passed), error: r.error, artifacts: r.artifacts };
   ```
   Keep `job_status` and `artifacts` as thin fallbacks: one for when an `execute` call times out before its job finishes, one for downloading files. MCP resource links to artifacts are a better fit than inlining bytes.
2. **Make `search` programmable as well.** Accept either `query` (keywords) or `code` that runs in its own QuickJS context against `declare const catalog: { entries: CatalogEntry[] }`, with no `cad` job bridge, so a search can never start a job. Example query: `catalog.entries.filter(e => e.kind === "example" && e.tags.includes("holes")).map(e => e.id)`.
3. **Put a compact hand-written `.d.ts` in the `execute` description.** It should declare `cad.submit / wait / status / cancel / artifacts / logs / search / example / version` and the `CadJobRequest` / `CadJobResult` types. Each validation option should be a typed field, not prose. Keep the text static and under about 1.5k tokens.
4. **Use one error contract everywhere.** Use `{code, message, hint, details}` with the same codes in the worker, the bridge and MCP results. Put the short form in the result and the full logs behind `cad.logs(id, {tail})`.
5. **Set budgets per `execute` call:**
   - wall time;
   - QuickJS memory and stack size;
   - number of bridge calls;
   - concurrent jobs;
   - output size, truncated structurally with markers.
6. **Grow capabilities through the catalog.** New FreeCAD features become catalog entries with tested examples (`tests/cad/test_worker.py::ExamplesBuild` enforces this), not new tools.
7. **Expose provenance.** Return `cad.version()` and the FreeCAD build in every job result.
8. **State the security model in the tool descriptions** (headless, sandboxed, validated), and annotate `search` with `readOnlyHint` and `execute` with `openWorldHint:false`.
