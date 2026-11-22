import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { habitOpenApiDocument } from './openapi-document.js';

/** `npm run openapi:update -w @teampulse/svc-habit`: rewrites docs/api/habit.openapi.json. */
const target = resolve(process.cwd(), process.argv[2] ?? '../../docs/api/habit.openapi.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(habitOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
