import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { identityOpenApiDocument } from './openapi-document.js';

/** `npm run openapi:update -w @teampulse/svc-identity`: rewrites docs/api/identity.openapi.json. */
const target = resolve(process.cwd(), process.argv[2] ?? '../../docs/api/identity.openapi.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(identityOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
