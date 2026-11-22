import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { insightOpenApiDocument } from './openapi-document.js';

/** `npm run openapi:update -w @teampulse/svc-insight`: rewrites docs/api/insight.openapi.json. */
const target = resolve(process.cwd(), process.argv[2] ?? '../../docs/api/insight.openapi.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(insightOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
