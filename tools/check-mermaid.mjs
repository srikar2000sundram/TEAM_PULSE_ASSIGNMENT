// Validates the syntax of every ```mermaid block in the repository's Markdown files.
// Usage: node tools/check-mermaid.mjs
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { JSDOM } from 'jsdom';

// Mermaid expects a browser-like environment, even for parse-only use.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false });

const root = process.cwd();
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build']);

async function* markdownFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(path);
    else if (entry.name.endsWith('.md')) yield path;
  }
}

const BLOCK = /```mermaid\r?\n([\s\S]*?)```/g;
let total = 0;
const failures = [];

for await (const file of markdownFiles(root)) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(BLOCK)) {
    total += 1;
    const line = text.slice(0, match.index).split('\n').length;
    try {
      await mermaid.parse(match[1]);
    } catch (error) {
      failures.push({
        where: `${relative(root, file)}:${line}`,
        message: String(error.message ?? error),
      });
    }
  }
}

for (const failure of failures) {
  console.error(`FAIL ${failure.where}\n${failure.message}\n`);
}
console.log(`${total - failures.length}/${total} Mermaid diagrams valid`);
process.exit(failures.length === 0 ? 0 : 1);
