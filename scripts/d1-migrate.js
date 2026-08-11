#!/usr/bin/env node
/**
 * Apply ordered SQL migrations to D1 (local or --remote).
 * Fresh installs can also use: npm run db:schema:local|remote (src/schema.sql).
 * Migrations are additive ALTER/INDEX statements for existing DBs.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const remote = process.argv.includes('--remote');
const mode = remote ? '--remote' : '--local';
const migrationsDir = path.join(root, 'migrations');

const files = fs
  .readdirSync(migrationsDir)
  .filter(function (f) {
    return /^\d+.*\.sql$/i.test(f);
  })
  .sort();

if (!files.length) {
  console.error('No migration files in migrations/');
  process.exit(1);
}

let failed = 0;
files.forEach(function (file) {
  const full = path.join(migrationsDir, file);
  console.log('Applying', file, '(' + (remote ? 'remote' : 'local') + ')');
  const result = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'flareboard', mode, '--file=' + full],
    { cwd: root, encoding: 'utf8', shell: true }
  );
  const out = String(result.stdout || '') + String(result.stderr || '');
  if (result.status !== 0) {
    // SQLite: duplicate column / already exists — treat as already applied
    if (
      /duplicate column name/i.test(out) ||
      /already exists/i.test(out) ||
      /duplicate column/i.test(out)
    ) {
      console.log('  skip (already applied):', file);
      return;
    }
    // Cloudflare D1 import sometimes 7500s on idempotent ALTER re-runs
    if (/\[code: 7500\]/i.test(out) && /ALTER TABLE/i.test(fs.readFileSync(full, 'utf8'))) {
      console.log('  skip (likely already applied; D1 7500 on ALTER):', file);
      return;
    }
    console.error(out || 'wrangler failed');
    failed += 1;
    return;
  }
  console.log('  ok:', file);
});

if (failed) {
  console.error('Migration finished with', failed, 'error(s)');
  process.exit(1);
}
console.log('Migrations complete.');
