# check=skip=InvalidDefaultArgInFrom
# The container images of the apps, built from their release tarballs (`npm pack` output) by
# tools/image/build.mjs, which passes the pinned base (tools/image/pins.json) and the labels.
# No `# syntax=` line: it would pull an unpinned Dockerfile frontend on every build; BuildKit's
# bundled frontend is pinned with BuildKit itself. The build context holds only app.tgz.
#
# Distroless: no shell, no package manager; the `nonroot` variant runs as uid 65532. ADD unpacks
# the tarball under /opt/package, root-owned and read-only for the process.

# The base comes from pins.json, so BASE_IMAGE has no default on purpose (the check= line).
ARG BASE_IMAGE

FROM ${BASE_IMAGE} AS base

FROM base AS cli
ADD app.tgz /opt/
ENTRYPOINT ["/nodejs/bin/node", "/opt/package/dist/src/cli/index.js"]

# The MCP server: stdio by default (`docker run -i`); `--transport http --host 0.0.0.0` serves
# POST /mcp on port 3000.
FROM base AS mcp
ADD app.tgz /opt/
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node", "/opt/package/dist/src/mcp/index.js"]
