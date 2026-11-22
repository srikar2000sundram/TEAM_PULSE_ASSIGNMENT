import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { notificationOpenApiDocument } from './openapi-document.js';

/** `npm run openapi:update -w @teampulse/svc-notification`: rewrites docs/api/notification.openapi.json. */
const target = resolve(
  process.cwd(),
  process.argv[2] ?? '../../docs/api/notification.openapi.json',
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(notificationOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
