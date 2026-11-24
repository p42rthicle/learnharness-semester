// Builds dist/ (manifest.json, main.js, backend.cjs, styles.css) for LearnHarness.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(HERE, 'dist');
if (fs.existsSync(dist) && fs.lstatSync(dist).isSymbolicLink()) throw new Error('dist/ is a symlink; refusing');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
await build({ entryPoints: [path.join(HERE, 'src/main.js')], outfile: path.join(dist, 'main.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'warning' });
await build({ entryPoints: [path.join(HERE, 'src/backend.mjs')], outfile: path.join(dist, 'backend.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'warning' });
fs.copyFileSync(path.join(HERE, 'manifest.json'), path.join(dist, 'manifest.json'));
fs.copyFileSync(path.join(HERE, 'src/styles.css'), path.join(dist, 'styles.css'));
console.log('built', fs.readdirSync(dist).map((f) => `${f} ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)}k`).join(', '));
