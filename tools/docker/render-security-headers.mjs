/**
 * Fills the nginx security-header template with the hashes of the inline scripts in the built app.
 *
 *   node tools/docker/render-security-headers.mjs <index.html> <template> <output>
 *
 * A Content-Security-Policy that allows `script-src 'self'` blocks the small inline script SvelteKit
 * writes into index.html. Allowing `'unsafe-inline'` would allow any injected script too, so instead the
 * policy lists the SHA-256 hash of each inline script that is really there: the browser runs exactly
 * those and nothing else.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = '__SCRIPT_HASHES__';

/** The text of every inline `<script>` (one without a `src`) in an HTML document. */
export function inlineScripts(html) {
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/i.test(match[1] ?? '')) found.push(match[2] ?? '');
  }
  return found;
}

/** `'sha256-...'` source expressions, one per distinct inline script. */
export function scriptHashes(html) {
  const hashes = new Set(
    inlineScripts(html).map(
      (script) => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`,
    ),
  );
  return [...hashes];
}

export function render(html, template) {
  if (!template.includes(PLACEHOLDER)) throw new Error(`The template has no ${PLACEHOLDER}`);
  const hashes = scriptHashes(html);
  if (hashes.length === 0) throw new Error('No inline script found: the app would not start');
  // Every occurrence: the placeholder must never survive into the served header.
  return template.replaceAll(PLACEHOLDER, hashes.join(' '));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [indexPath, templatePath, outputPath] = process.argv.slice(2);
  if (!indexPath || !templatePath || !outputPath) {
    console.error('Usage: render-security-headers.mjs <index.html> <template> <output>');
    process.exit(2);
  }
  writeFileSync(
    outputPath,
    render(readFileSync(indexPath, 'utf8'), readFileSync(templatePath, 'utf8')),
  );
  console.log(`Wrote ${outputPath}`);
}
