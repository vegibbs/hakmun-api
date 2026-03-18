'use strict';

/**
 * Creates a limited hakmun_app database user for app runtime.
 *
 * hakmun_app gets DML only (SELECT, INSERT, UPDATE, DELETE) — no DDL.
 * The migration runner retains the superuser connection (DATABASE_MIGRATION_URL).
 *
 * Requires HAKMUN_APP_DB_PASSWORD to be set in the Railway environment.
 * Idempotent: skips user creation if hakmun_app already exists.
 */
module.exports.up = async function up(client) {
  const password = process.env.HAKMUN_APP_DB_PASSWORD;
  if (!password) throw new Error('HAKMUN_APP_DB_PASSWORD is not set');

  // CREATE USER is not parameterizable — password comes from a trusted env var, not user input.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hakmun_app') THEN
        CREATE USER hakmun_app WITH PASSWORD '${password.replace(/'/g, "''")}';
      END IF;
    END
    $$
  `);

  await client.query('GRANT CONNECT ON DATABASE railway TO hakmun_app');
  await client.query('GRANT USAGE ON SCHEMA public TO hakmun_app');
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hakmun_app');
  await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hakmun_app');
  await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hakmun_app');
  await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hakmun_app');
};
