import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { recommendationOpenApiDocument } from './openapi-document.js';

/** `npm run openapi:update -w @teampulse/svc-recommendation`: rewrites docs/api/recommendation.openapi.json. */
const target = resolve(
  process.cwd(),
  process.argv[2] ?? '../../docs/api/recommendation.openapi.json',
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(recommendationOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
