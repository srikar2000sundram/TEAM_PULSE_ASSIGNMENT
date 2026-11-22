import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { notificationOpenApiDocument } from '../../src/cli/openapi-document.js';

const published = fileURLToPath(
  new URL('../../../../docs/api/notification.openapi.json', import.meta.url),
);

describe('published OpenAPI document', () => {
  it('matches the code, so the documentation cannot drift', () => {
    expect(
      existsSync(published),
      'run: npm run openapi:update -w @teampulse/svc-notification',
    ).toBe(true);
    const onDisk = JSON.parse(readFileSync(published, 'utf8')) as unknown;
    // Round-trip through JSON so `undefined` values compare the way they serialise.
    const generated = JSON.parse(JSON.stringify(notificationOpenApiDocument())) as unknown;
    expect(
      onDisk,
      'docs/api/notification.openapi.json is out of date. Run: npm run build && npm run openapi:update -w @teampulse/svc-notification',
    ).toEqual(generated);
  });

  it('documents every operation as bearer-protected', () => {
    const document = notificationOpenApiDocument() as {
      paths: Record<string, Record<string, { security: unknown[] }>>;
    };
    const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
    expect(operations).toHaveLength(4);
    for (const operation of operations) expect(operation.security.length).toBeGreaterThan(0);
  });
});
