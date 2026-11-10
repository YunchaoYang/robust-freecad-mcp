#!/usr/bin/env bash
# Creates the pinned FreeCAD + Node runtime with micromamba (no root needed), installs npm deps and builds.
set -euo pipefail
ENV_NAME="${FREECAD_MCP_ENV:-freecad-mcp}"
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$HOME/micromamba}"
if ! command -v micromamba >/dev/null; then
  arch=$(uname -m); case "$arch" in x86_64) plat=linux-64;; aarch64) plat=linux-aarch64;; *) echo "unsupported arch $arch"; exit 1;; esac
  mkdir -p "$HOME/.local/bin"
  curl -Ls "https://micro.mamba.pm/api/micromamba/$plat/latest" | tar -xj -C "$HOME/.local" bin/micromamba
  export PATH="$HOME/.local/bin:$PATH"
fi
if [ ! -x "$MAMBA_ROOT_PREFIX/envs/$ENV_NAME/bin/python" ]; then
  micromamba create -y -n "$ENV_NAME" -c conda-forge "freecad=1.1.3" "nodejs=22" "python=3.12"
fi
PREFIX="$MAMBA_ROOT_PREFIX/envs/$ENV_NAME"
export PATH="$PREFIX/bin:$PATH"
cd "$(dirname "$0")/.."
npm ci
npm run build
echo
echo "FREECAD_MCP_PYTHON=$PREFIX/bin/python"
echo "Register with Claude Code:"
echo "  claude mcp add robust-freecad -e FREECAD_MCP_PYTHON=$PREFIX/bin/python -- $PREFIX/bin/node $PWD/dist/apps/mcp-server/src/server.js"
