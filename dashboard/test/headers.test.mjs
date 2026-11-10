import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

test('the page has no inline script and no script from another origin, so the policy can forbid both', () => {
  const html = read('src/index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
  assert.ok(scripts.length >= 2);
  for (const attrs of scripts) assert.match(attrs, /\bsrc="(?!https?:|\/\/)[^"]+"/, `inline or remote script: ${attrs}`);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler');
});

test('_headers carries a Content-Security-Policy without unsafe script sources, and the usual protections', () => {
  const headers = read('src/_headers');
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? '';
  const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
  assert.equal(directive('script-src'), "script-src 'self'");
  assert.equal(directive('default-src'), "default-src 'self'");
  assert.equal(directive('object-src'), "object-src 'none'");
  assert.equal(directive('frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(directive('connect-src'), "connect-src 'self'");
  assert.doesNotMatch(csp, /unsafe-eval|\*|https?:\/\//);
  for (const h of ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'Strict-Transport-Security:', 'Cache-Control: no-store']) {
    assert.ok(headers.includes(h), h);
  }
});

test('the build copies the theme script and _headers next to index.html', () => {
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'ignore' });
  for (const f of ['index.html', 'app.js', 'app.css', 'theme.js', '_headers']) assert.ok(existsSync(join(root, 'dist', f)), f);
  assert.equal(readFileSync(join(root, 'dist', '_headers'), 'utf8'), read('src/_headers'));
});
