import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('public');

test('PWA manifest has a standalone entrypoint and existing install icons', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of manifest.icons) assert.ok(fs.statSync(path.join(root, icon.src.slice(1))).size > 100);
});

test('Offline cache only targets static files and avoids bill APIs', () => {
  const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(source, /pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(source.match(/const FILES = \[(.*?)\];/s)?.[1] || '', /\/api\//);
  assert.ok(fs.existsSync(path.join(root, 'saved-access.mjs')));
});
