import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { challengeOpenApiDocument } from '../../src/cli/openapi-document.js';

const published = fileURLToPath(
  new URL('../../../../docs/api/challenge.openapi.json', import.meta.url),
);

describe('published OpenAPI document', () => {
  it('matches the code, so the documentation cannot drift', () => {
    expect(existsSync(published), 'run: npm run openapi:update -w @teampulse/svc-challenge').toBe(
      true,
    );
    const onDisk = JSON.parse(readFileSync(published, 'utf8')) as unknown;
    // Round-trip through JSON so `undefined` values compare the way they serialise.
    const generated = JSON.parse(JSON.stringify(challengeOpenApiDocument())) as unknown;
    expect(
      onDisk,
      'docs/api/challenge.openapi.json is out of date. Run: npm run build && npm run openapi:update -w @teampulse/svc-challenge',
    ).toEqual(generated);
  });

  it('documents every operation as bearer-protected', () => {
    const document = challengeOpenApiDocument() as {
      paths: Record<string, Record<string, { security: unknown[] }>>;
    };
    const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
    expect(operations).toHaveLength(8);
    for (const operation of operations) expect(operation.security.length).toBeGreaterThan(0);
  });
});
