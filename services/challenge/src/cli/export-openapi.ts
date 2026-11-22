import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { challengeOpenApiDocument } from './openapi-document.js';

/** `npm run openapi:update -w @teampulse/svc-challenge`: rewrites docs/api/challenge.openapi.json. */
const target = resolve(process.cwd(), process.argv[2] ?? '../../docs/api/challenge.openapi.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(challengeOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
