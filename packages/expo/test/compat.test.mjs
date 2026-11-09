// Backward compatibility contract: @open-observe/expo is a drop-in replacement of expo-observe. Every name the original exports
// (values and types) must be exported by both entries of the fork (native src/index.ts, web src/web/observe.tsx). The fork may
// only add names (the gate). Types are checked by test/compat.check.ts: `npm run typecheck` (run by this test as well).
// The original comes from the devDependency `expo-observe` in this package's node_modules (run `npm install` first); without it
// the tests are reported as skipped, with the reason.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ORIGINAL = here('../node_modules/expo-observe/build/index.d.ts');
const TSC = here('../node_modules/.bin/tsc');

/** The exported names of a module's source or declaration text (re-exports, aliases, declarations, default). */
function exportedNames(text) {
  const names = new Set();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const item = part.trim().replace(/^type\s+/, '');
      if (!item) continue;
      names.add(item.includes(' as ') ? item.split(/\s+as\s+/)[1].trim() : item);
    }
  }
  for (const m of code.matchAll(/export\s+(?:declare\s+)?(?:const|let|var|class|function|type|interface|namespace)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  if (/export\s+default\b/.test(code)) names.add('default');
  return names;
}

const original = existsSync(ORIGINAL) ? exportedNames(readFileSync(ORIGINAL, 'utf8')) : null;

for (const [label, file] of [['native', '../src/index.ts'], ['web', '../src/web/observe.tsx']]) {
  test(`${label} entry exports everything expo-observe exports`, { skip: original ? false : 'expo-observe is not installed (npm install in packages/expo)' }, () => {
    const fork = exportedNames(readFileSync(here(file), 'utf8'));
    assert.ok(original.size >= 12, `the parser found only ${original.size} names in the original`);
    const missing = [...original].filter((n) => !fork.has(n));
    assert.deepEqual(missing, [], `missing from ${file}`);
  });
}

test('the fork only adds the gate on top of the original', { skip: original ? false : 'expo-observe is not installed (npm install in packages/expo)' }, () => {
  const fork = exportedNames(readFileSync(here('../src/index.ts'), 'utf8'));
  const added = [...fork].filter((n) => !original.has(n)).sort();
  assert.deepEqual(added, ['isObserveEnabled', 'setObserveEnabled']);
});

test('types of both entries are assignable to the original (tsc)', { skip: existsSync(TSC) && original ? false : 'TypeScript or expo-observe is not installed (npm install in packages/expo)' }, () => {
  execFileSync(TSC, ['--noEmit', '-p', here('./tsconfig.compat.json')], { cwd: here('..'), stdio: 'pipe' });
});

test('package.json exposes every entry point of expo-observe, and the browser condition picks the web collector', () => {
  const pkg = JSON.parse(readFileSync(here('../package.json'), 'utf8'));
  const originalPackage = existsSync(here('../node_modules/expo-observe/package.json')) ? JSON.parse(readFileSync(here('../node_modules/expo-observe/package.json'), 'utf8')) : null;
  for (const subpath of originalPackage ? Object.keys(originalPackage.exports) : ['.', './integrations/react-navigation']) {
    assert.ok(pkg.exports[subpath], `${subpath} is exported by expo-observe`);
  }
  for (const entry of Object.values(pkg.exports)) {
    if (typeof entry === 'string') continue;
    for (const target of Object.values(entry)) assert.ok(existsSync(here(`../${target}`)), `${target} exists`);
  }
  assert.equal(pkg.exports['.'].browser, './src/index.web.ts');
  assert.equal(pkg.exports['.'].default, './src/index.ts');
  assert.equal(pkg.name, '@open-observe/expo');
});
