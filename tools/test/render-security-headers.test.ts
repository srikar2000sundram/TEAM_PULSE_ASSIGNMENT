import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inlineScripts, render, scriptHashes } from '../docker/render-security-headers.mjs';

const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

const html = `<html><head>
<link href="/a.js" rel="modulepreload"><script src="/external.js"></script>
</head><body><script>
  boot();
</script></body></html>`;

describe('the real template', () => {
  const template = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'infra',
      'docker',
      'security-headers.conf.template',
    ),
    'utf8',
  );

  it('has no placeholder left once rendered, and allows exactly the inline script', () => {
    const output = render(html, template);
    expect(output).not.toContain('__SCRIPT_HASHES__');
    expect(output).toContain(`script-src 'self' ${hash('\n  boot();\n')};`);
  });

  it('allows inline styles for the web components, but never inline scripts or eval', () => {
    // The header's value only: the template's comments also mention these words.
    const policy = /Content-Security-Policy "([^"]*)"/.exec(render(html, template))?.[1] ?? '';
    const scriptSrc = /script-src [^;]*/.exec(policy)?.[0] ?? '';
    expect(scriptSrc).toContain("'sha256-");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });
});

describe('render-security-headers', () => {
  it('finds inline scripts and ignores scripts loaded from a file', () => {
    expect(inlineScripts(html)).toEqual(['\n  boot();\n']);
  });

  it('hashes exactly the inline script text', () => {
    expect(scriptHashes(html)).toEqual([hash('\n  boot();\n')]);
  });

  it('lists one hash for identical scripts', () => {
    expect(scriptHashes('<script>a()</script><script>a()</script>')).toHaveLength(1);
  });

  it('puts the hashes into the template', () => {
    const output = render(html, "script-src 'self' __SCRIPT_HASHES__;");
    expect(output).toBe(`script-src 'self' ${hash('\n  boot();\n')};`);
  });

  it('refuses to build an image whose app would not start', () => {
    expect(() => render('<html></html>', '__SCRIPT_HASHES__')).toThrow(/No inline script/);
  });

  it('refuses a template without the placeholder', () => {
    expect(() => render(html, 'script-src self;')).toThrow(/placeholder|SCRIPT_HASHES/);
  });
});
