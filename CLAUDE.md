# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HakMun API is a Node.js/Express REST API backend for a Korean language learning platform. It manages authentication, vocabulary/content, Google Docs integration, and multimedia assets. Deployed on Railway with PostgreSQL.

## Commands

```bash
npm install          # Install dependencies
node server.js       # Start server (default port 8080)
npm start            # Same as node server.js
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
- `util/` — Environment parsing with fail-fast (`env.js`), JSON logger with Better Stack shipping (`log.js`), OpenAI client wrapper (`openai.js`), timeout helpers (`time.js`)
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

## Required Environment Variables

Checked at boot (fail-fast): `DATABASE_URL`, `SESSION_JWT_SECRET`, `APPLE_CLIENT_IDS`, `NODE_ENV`, `ROOT_ADMIN_USER_IDS` (production only).

## Common Code Patterns

- `requireJsonField(req, res, fieldName)` — validates and extracts required JSON body fields, sends 400 on missing
- `withTimeout(promise, ms, label)` — races a promise against a timeout
- `requireEntitlement(ent)` — Express middleware that checks JWT entitlements, sends 403
- `looksLikeUUID(s)` — regex UUID validation used throughout
- Structured JSON logging via `util/log.js` with debug scopes; no secrets in log output
