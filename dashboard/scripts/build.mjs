// Builds the dashboard to static files in dist/ (index.html, app.js, app.css) that the Worker serves through its assets binding.
// `node scripts/build.mjs --watch` rebuilds on every change.
import { build, context } from 'esbuild';
import { watch as watchFile } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: { app: join(root, 'src/main.tsx') },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: ['es2022', 'firefox115', 'chrome110', 'safari16'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  loader: { '.css': 'css' },
  logLevel: 'info',
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const copyStatic = async () => {
  await copyFile(join(root, 'src/index.html'), join(dist, 'index.html'));
  await copyFile(join(root, 'src/style.css'), join(dist, 'app.css'));
  await copyFile(join(root, 'src/theme.js'), join(dist, 'theme.js'));
  await copyFile(join(root, 'src/_headers'), join(dist, '_headers'));
};
await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  for (const file of ['index.html', 'style.css', 'theme.js', '_headers']) watchFile(join(root, 'src', file), () => copyStatic().catch(console.error));
  console.log('Watching src/ (rebuilds on every change).');
} else {
  await build(options);
}
