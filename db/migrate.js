/**
 * db/migrate.js — HakMun migration runner
 *
 * Scans db/migrations/*.sql (sorted), runs any not yet recorded in
 * schema_migrations, and logs them. Each migration runs in its own
 * transaction — failure stops the process with exit code 1.
 *
 * Usage:
 *   node db/migrate.js            # run all pending
 *   node db/migrate.js --list     # show applied/pending status
 *   node db/migrate.js --dry-run  # show what would run without running
 *
 * Requires DATABASE_URL in environment (Railway injects this automatically).
 * For local use: set DATABASE_URL in .env or export it before running.
 *
 * Tracking table: schema_migrations (created automatically on first run)
 *
 * NOTE: schema_change_log is a legacy table from the previous migration system
 * (migrate.sh, migrations 219-246). It is kept as a historical record only.
 * Do not write to it. Do not use it to determine migration state.
 */

'use strict';

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env for local development (ignored if vars already set)
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch (_) {}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const args = process.argv.slice(2);
const LIST = args.includes('--list');
const DRY_RUN = args.includes('--dry-run');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    // Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum   TEXT        NOT NULL
      )
    `);

    // Load applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    const appliedSet = new Set(applied.map(r => r.filename));

    // Load migration files
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && !fs.statSync(path.join(MIGRATIONS_DIR, f)).isDirectory())
      .sort();

    if (LIST) {
      for (const file of files) {
        const status = appliedSet.has(file) ? '[applied]' : '[pending]';
        console.log(`  ${status} ${file}`);
      }
      return;
    }

    let pending = 0;
    let skipped = 0;

    for (const file of files) {
      if (appliedSet.has(file)) {
        skipped++;
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      if (DRY_RUN) {
        console.log(`  [would apply] ${file}`);
        pending++;
        continue;
      }

      process.stdout.write(`  Running ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [file, checksum]
        );
        await client.query('COMMIT');
        console.log('done.');
        pending++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED.');
        console.error(`\nERROR in ${file}:\n${err.message}`);
        process.exit(1);
      }
    }

    if (DRY_RUN) {
      console.log(`\n${pending} migration(s) would run.`);
    } else {
      console.log(`\n${pending} migration(s) applied, ${skipped} already applied.`);
    }

  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Migration runner error:', err.message);
  process.exit(1);
});
