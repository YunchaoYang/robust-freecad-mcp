# UNTESTED on the development host (Docker was not accessible there). Provided as the
# Phase-5 starting point: non-root, read-only rootfs, no network. Landlock + seccomp are
# applied by the worker inside the container as well (both work unprivileged).
FROM mambaorg/micromamba:2.3.3
RUN micromamba install -y -n base -c conda-forge "freecad=1.1.3" "nodejs=22" "python=3.12" && micromamba clean -a -y
WORKDIR /app
COPY --chown=$MAMBA_USER:$MAMBA_USER package.json package-lock.json tsconfig.json ./
RUN /opt/conda/bin/npm ci
COPY --chown=$MAMBA_USER:$MAMBA_USER apps ./apps
COPY --chown=$MAMBA_USER:$MAMBA_USER packages ./packages
COPY --chown=$MAMBA_USER:$MAMBA_USER tests ./tests
RUN /opt/conda/bin/npx tsc -p tsconfig.json
ENV FREECAD_MCP_PYTHON=/opt/conda/bin/python FREECAD_MCP_DATA_DIR=/data
USER $MAMBA_USER
ENTRYPOINT ["/opt/conda/bin/node", "/app/dist/apps/mcp-server/src/server.js"]
