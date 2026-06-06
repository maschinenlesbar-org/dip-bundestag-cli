#!/usr/bin/env node
// Binary entry point. Thin shim around run(); all logic lives in run.ts/program.ts.

import { run } from "./run.js";

const exitCode = await run(process.argv.slice(2));
process.exitCode = exitCode;
