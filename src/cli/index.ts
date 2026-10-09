#!/usr/bin/env node
// Binary entry point. Thin shim around run(); all logic lives in run.ts/program.ts.

import { handleOutputErrors } from "./io.js";
import { processLogger, run } from "./run.js";

const argv = process.argv.slice(2);
handleOutputErrors(process, undefined, processLogger(argv));
const exitCode = await run(argv);
process.exitCode = exitCode;
