#!/usr/bin/env node
/** `lun` — Lunaris CLI entrypoint. */
import { buildProgram } from './program.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
