/**
 * Runs `docker compose` or, when Docker is not installed, `podman compose`, against the local stack.
 *
 *   node tools/local/compose.mjs up        build and start everything in the background
 *   node tools/local/compose.mjs down      stop everything (data is kept)
 *   node tools/local/compose.mjs reset     stop everything and DELETE the data
 *   node tools/local/compose.mjs ps | logs [service]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composeFile = join(root, 'infra', 'local', 'compose.yaml');
const envFile = join(root, 'infra', 'local', '.env');

const has = (command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore', shell: true }).status === 0;
const engine = has('docker') ? 'docker' : has('podman') ? 'podman' : null;
if (engine === null) {
  process.stderr.write('Neither docker nor podman was found. Install one of them and try again.\n');
  process.exit(1);
}

const [command = 'up', ...rest] = process.argv.slice(2);
if (!existsSync(envFile)) {
  process.stderr.write('Missing infra/local/.env. Run: node tools/local/make-env.mjs\n');
  process.exit(1);
}

const base = [engine, 'compose', '-f', composeFile, '--env-file', envFile];
const actions = {
  up: [...base, 'up', '--build', '-d', ...rest],
  down: [...base, 'down', ...rest],
  reset: [...base, 'down', '--volumes', ...rest],
  ps: [...base, 'ps', ...rest],
  logs: [...base, 'logs', '--tail', '100', ...rest],
};
const line = actions[command];
if (line === undefined) {
  process.stderr.write(`Unknown command "${command}". Use: ${Object.keys(actions).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`> ${line.join(' ')}\n`);
process.exit(spawnSync(line[0], line.slice(1), { stdio: 'inherit', shell: false }).status ?? 1);
