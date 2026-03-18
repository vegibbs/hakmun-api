# CLAUDE.md — hakmun-api

**Operating model (session roles, bridge protocol, impl docs, working principles):** See `atlas-dev/CLAUDE.md` Part 1. This file covers HakMun-specific context only.

## Project Overview

HakMun API is a Node.js/Express REST API backend for a Korean language learning platform. It manages authentication, vocabulary/content, Google Docs integration, and multimedia assets. Deployed on Railway with PostgreSQL.

## Environments & Deploy

| Branch | Railway Environment | URL |
|--------|---------------------|-----|
| `sandbox` | sandbox | hakmun-api-sandbox.up.railway.app |
| `main` | production | hakmun-api-production.up.railway.app |

- **Default: commit and push to `sandbox`.** Railway auto-deploys on push — target branch determines the environment.
- To promote to production: merge `sandbox` into `main` and push `main`.
- ccdev runs on the Hetzner server (`dev.atlasdatanav.com`), not locally.

## Database Migrations

Migrations live in `db/migrations/`. Two file types are supported:
- **SQL** (`NNN_description.sql`) — idempotent DDL/DML, runs directly
- **JS** (`NNN_description.js`) — exports `async up(client)` for env-var-dependent logic (e.g. creating DB users)

The runner is `db/migrate.js` — Node.js, uses `pg`, no system dependencies.

**Three hard rules:**
1. All migration SQL must be idempotent — `IF NOT EXISTS`, `IF EXISTS` on all DDL.
2. Create a migration → run it immediately. Never leave one unrun.
3. `db/migrate.js` is the only authorized way to apply migrations.

```bash
npm run migrate           # run all pending
npm run migrate:list      # show applied/pending status
npm run migrate:dry-run   # show what would run without running
```

Migrations run automatically on every Railway deploy (start script: `node db/migrate.js && node server.js`). The runner uses `DATABASE_MIGRATION_URL` (superuser) with fallback to `DATABASE_URL`. Migrations require DDL privileges — the app runtime user (`hakmun_app`) does not have them.

**Tracking:** `schema_migrations` table — one row per applied migration file.

**Legacy:** `schema_change_log` is a historical record of migrations 219–246 applied before the migration system was rebuilt (2026-03-18). It is kept for reference only. Do not write to it. Do not use it to determine migration state. `db/migrate.sh.legacy` is the old bash runner — kept for reference, do not run it.

## Commands

```bash
npm install          # Install dependencies
npm start            # Run migrations then start server
node server.js       # Start server only (skip migrations)
```

**Smoke tests** (requires a running server):
```bash
HAKMUN_API_BASE_URL=http://localhost:8080 SMOKE_TEST_SECRET=<secret> bash ops/server_smoke.sh
```

There is no automated test suite, linter, or build step.

## Architecture

### Entry Points

- `server.js` — Process entry: validates environment, connects DB, calls `listen()`
- `app.js` — Express app factory: mounts middleware and all routes. Does NOT call `listen()`

### Key Directories

- `auth/` — Apple Sign-In verification (`apple.js`), JWT session management and entitlements (`session.js`)
- `db/` — PostgreSQL connection pool with SSL, timeouts, and startup fingerprinting (`pool.js`)
- `util/` — Environment parsing with fail-fast (`env.js`), JSON logger with Better Stack shipping (`log.js`), OpenAI client wrapper (`openai.js`), timeout helpers (`time.js`), audit log writer (`audit.js`)
- `routes/` — All API route handlers, mounted under `/v1/`
- `ops/` — Smoke test script

### Authentication & Authorization

JWT-based (HS256 via `jose`). Two token types: access (30 min) and refresh (30 days). Entitlements are server-authoritative capabilities embedded in tokens: `app:use`, `teacher:tools`, `admin:*`, `session:impersonating`.

Root admin IDs are pinned via `ROOT_ADMIN_USER_IDS` env var with self-healing promotion on read paths. Impersonation uses short-lived tokens (10 min) with `imp`/`act` claims; admin ops are forbidden while impersonating.

### Database Patterns

All queries use parameterized SQL via `pg` pool. Async operations are wrapped with `withTimeout()`. Some multi-step writes use `SAVEPOINT` for rollback protection. No ORM — raw SQL throughout.

### API Conventions

- Versioned under `/v1/`
- Auth via `Authorization: Bearer <token>` header
- Every response includes `X-HakMun-Request-Id` header
- Success shape: `{ ok: true, items: [...] }`
- Error shape: `{ ok: false, error: "ERROR_CODE" }` or `{ error: "message" }`
- JSON body limit: 1MB. ETags disabled.

### Content Model

Content types: sentence, paragraph, passage, pattern. Library registry decouples ownership from visibility. Audience model: personal, teacher, public. Global states: preliminary, approved, rejected.

### Google Docs Integration

Five route files (`google_docs_*.js`) handle a pipeline: parse link → OAuth → snapshot HTML → extract highlights via OpenAI → preview → commit to user library. Snapshots use 90-day session slicing.

### OpenAI Integration

Server-side only (key never exposed). JSON-only structured output enforced. 25-second timeout with single retry. Multiple prompt profiles for different use cases.

### Storage

S3-compatible (AWS SDK) for audio and PDF uploads via multer. Presigned URLs for retrieval. MIME type allowlist with per-type size limits (25MB audio, 10MB PDF).

## Database Security

**Two DB credentials, two roles:**

| Var | User | Privileges | Used by |
|-----|------|------------|---------|
| `DATABASE_MIGRATION_URL` | `postgres` (superuser) | DDL + DML | `db/migrate.js` at deploy time |
| `DATABASE_URL` | `hakmun_app` | DML only (SELECT/INSERT/UPDATE/DELETE) | App at runtime |

`hakmun_app` cannot CREATE/DROP tables, CREATE USERS, or modify schema. If `DATABASE_MIGRATION_URL` is not set, the runner falls back to `DATABASE_URL` (local dev only — local DB is assumed to be superuser).

**Audit log:** `audit_log` table is append-only at the DB level — `hakmun_app` has INSERT only; UPDATE and DELETE are revoked. Records cannot be erased by the application. Key events logged: `user.signin`, `admin.user_create`, `admin.user_update`, `admin.user_flags_update`, `admin.profile_link`, `admin.profile_unlink`. Use `util/audit.js` for all new audit writes.

**Postgres:** Internal-only (`postgres.railway.internal`). No public TCP proxy. Not reachable from outside Railway's network.

## Required Environment Variables

Checked at boot (fail-fast): `DATABASE_URL`, `SESSION_JWT_SECRET`, `APPLE_CLIENT_IDS`, `NODE_ENV`, `ROOT_ADMIN_USER_IDS` (production only).

Set in Railway, not required at boot: `DATABASE_MIGRATION_URL` (superuser, for migrations), `HAKMUN_APP_DB_PASSWORD` (only needed when creating the `hakmun_app` user — already done).

## Common Code Patterns

- `requireJsonField(req, res, fieldName)` — validates and extracts required JSON body fields, sends 400 on missing
- `withTimeout(promise, ms, label)` — races a promise against a timeout
- `requireEntitlement(ent)` — Express middleware that checks JWT entitlements, sends 403
- `looksLikeUUID(s)` — regex UUID validation used throughout
- Structured JSON logging via `util/log.js` with debug scopes; no secrets in log output

## Related Repos

| Repo | What |
|------|------|
| `hakMun-engine` | Background workers (doc parsing, NIKL XML ingest). Shares the same Railway Postgres database. |
| `HakMun` (Swift) | iOS app client. Connects to this API. Builds locally in Xcode — no CI pipeline. |
