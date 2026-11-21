// Entry driver for the csv-reader-speed-01 bounty. The grader runs
// `node main.ts` (Node 22, type stripping on): every case in
// cases.json under the input directory is answered with run() from
// solve.js, and the answers are written, in order, as one JSON array to
// answers.json under the output directory. MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR override the /input and /output defaults.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off before solve.js loads, matching the
// house baseline, so the timed work runs under the same GC behaviour.
setFlagsFromString('--no-incremental-marking');

/** solve.js loaded by URL; the .js module has no types, so its shape is stated here. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const entry of cases) {
  answers.push(run(entry.input));
}
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
