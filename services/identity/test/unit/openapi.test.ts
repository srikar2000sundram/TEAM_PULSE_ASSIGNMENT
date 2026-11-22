import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { identityOpenApiDocument } from '../../src/cli/openapi-document.js';

const published = fileURLToPath(
  new URL('../../../../docs/api/identity.openapi.json', import.meta.url),
);

describe('published OpenAPI document', () => {
  it('matches the code, so the documentation cannot drift', () => {
    const onDisk = JSON.parse(readFileSync(published, 'utf8')) as unknown;
    // Round-trip through JSON so `undefined` values compare the way they serialise.
    const generated = JSON.parse(JSON.stringify(identityOpenApiDocument())) as unknown;
    expect(
      onDisk,
      'docs/api/identity.openapi.json is out of date. Run: npm run build && npm run openapi:update -w @teampulse/svc-identity',
    ).toEqual(generated);
  });

  it('documents every route as either public or bearer-protected', () => {
    const document = identityOpenApiDocument() as {
      paths: Record<string, Record<string, { security: unknown[] }>>;
    };
    const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
    expect(operations.length).toBeGreaterThanOrEqual(14);
    for (const operation of operations) expect(Array.isArray(operation.security)).toBe(true);
  });
});
