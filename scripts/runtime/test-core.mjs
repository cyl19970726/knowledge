import {spawn} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const suites = [
  ['packages/knowledge/test', new Set(['daily-research.test.ts', 'daily-report-archive.test.ts'])],
  ['packages/knowledge-contracts/test', new Set()],
  ['packages/knowledge-client/test', new Set()],
  ['apps/knowledge-api/test', new Set()],
  ['apps/knowledge-web/test', new Set()],
];
const files = suites.flatMap(([directory, excluded]) => readdirSync(new URL(`../../${directory}/`, import.meta.url))
  .filter(name => name.endsWith('.test.ts') && !excluded.has(name))
  .map(name => `${directory}/${name}`)
  .sort());
const child = spawn(process.execPath, [
  '--import', './scripts/runtime/test-environment.mjs',
  '--import', 'tsx',
  '--test',
  ...files,
], {cwd: root, env: process.env, stdio: 'inherit'});
child.on('error', () => {
  console.error('Could not start core tests');
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
