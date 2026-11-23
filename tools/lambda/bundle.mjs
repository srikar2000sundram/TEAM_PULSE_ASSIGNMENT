/**
 * Bundles each Lambda into one self-contained file, build/lambda/<name>/index.mjs, because a Lambda
 * is uploaded as a zip and has no node_modules folder of ours. Run `npm run build` first (it compiles
 * the TypeScript this reads), then `npm run bundle:lambdas`. Terraform zips the output folders.
 *
 *   streak -> lambdas/streak/dist/handler.js   (exports: handler)
 *   badge  -> lambdas/badge/dist/handler.js    (exports: handler, totalsHandler)
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLES = {
  streak: 'lambdas/streak/dist/handler.js',
  badge: 'lambdas/badge/dist/handler.js',
};

for (const [name, entry] of Object.entries(BUNDLES)) {
  const input = join(root, entry);
  if (!existsSync(input)) {
    throw new Error(`${entry} is missing. Run "npm run build" first.`);
  }
  const file = join(root, 'build', 'lambda', name, 'index.mjs');
  await build({
    input,
    platform: 'node',
    // Lambda's nodejs22.x runtime; everything else is bundled in so the zip needs no node_modules.
    output: { file, format: 'esm', minify: false, sourcemap: false, codeSplitting: false },
    logLevel: 'warn',
  });
  const kib = Math.round(statSync(file).size / 1024);
  process.stdout.write(`built build/lambda/${name}/index.mjs (${kib} KiB)\n`);
}

if (readdirSync(join(root, 'build', 'lambda')).length !== Object.keys(BUNDLES).length) {
  throw new Error('Unexpected files in build/lambda');
}
