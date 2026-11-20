// The app's name, version and description, read from its own package.json:
// dist/src/mcp/version.js -> ../../../package.json (apps/mcp/package.json in the repository,
// package/package.json in the tarball).

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string; description: string };

export const VERSION: string = manifest.version;

/** What the server is, for --help. */
export const DESCRIPTION: string = manifest.description;

/** The bin, and the first part of every log topic (`dip-mcp.<area>`). */
export const PROGRAM = "dip-mcp";

export const USER_AGENT = `${PROGRAM}/${VERSION}`;
