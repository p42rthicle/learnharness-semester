// Copies dist/ into LearnHarness's plugins folder (<plugins>/semester/dist/), keeping <plugins>/semester/data/.
// Usage: node scripts/install.mjs [--data-dir <LearnHarness data dir>]   (default: the installed app's data)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--data-dir');
const dataDir = i > 0 ? process.argv[i + 1] : path.join(os.homedir(), 'Library/Application Support/LearnHarness/data');
const target = path.join(dataDir, 'plugins', 'semester');
const src = path.join(HERE, 'dist');
if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('Run the build first (npm run build)');
fs.mkdirSync(target, { recursive: true });
const dst = path.join(target, 'dist');
if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) throw new Error(`${dst} is a symlink; refusing`);
fs.rmSync(dst, { recursive: true, force: true }); // only the code; data/ next to it is kept
fs.cpSync(src, dst, { recursive: true });
console.log(`installed into ${dst} (data kept). Restart LearnHarness, then enable "Semester" in Settings → Community plugins.`);
