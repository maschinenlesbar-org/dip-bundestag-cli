#!/usr/bin/env node
// Binary entry point. Thin shim around run(); all logic lives in run.ts/program.ts.

import { exitOnSignalsAsPid1, handleOutputErrors } from "./io.js";
import { installWarningLog } from "./log.js";
import { processLogger, run } from "./run.js";

const argv = process.argv.slice(2);
// In a container the CLI is PID 1, which ignores a signal nothing listens for.
exitOnSignalsAsPid1();
// What happens outside run() is logged too, in the format argv asks for.
const log = processLogger(argv);
installWarningLog(process, log);
handleOutputErrors(process, undefined, log);
const exitCode = await run(argv);
process.exitCode = exitCode;
