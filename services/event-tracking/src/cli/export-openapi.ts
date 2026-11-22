import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { eventTrackingOpenApiDocument } from './openapi-document.js';

/** `npm run openapi:update -w @teampulse/svc-event-tracking`: rewrites docs/api/event-tracking.openapi.json. */
const target = resolve(
  process.cwd(),
  process.argv[2] ?? '../../docs/api/event-tracking.openapi.json',
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(eventTrackingOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
