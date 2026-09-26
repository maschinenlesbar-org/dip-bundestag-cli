#!/usr/bin/env node
// Binary entry point. Thin shim around run(); all logic lives in run.ts/program.ts.

import { handleOutputErrors } from "./io.js";
import { run } from "./run.js";

handleOutputErrors();
const exitCode = await run(process.argv.slice(2));
process.exitCode = exitCode;
