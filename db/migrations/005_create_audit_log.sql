-- Migration 005: Create audit_log table
--
-- Append-only log of security-relevant events: authentication, account
-- changes, admin actions, and sensitive data access. Designed to satisfy
-- SOC2 audit trail requirements.
--
-- DB-level tamper protection: hakmun_app (app runtime user) is granted
-- INSERT only on this table — no UPDATE or DELETE. Records cannot be
-- erased or altered by the application. Only the migration runner
-- (superuser via DATABASE_MIGRATION_URL) can modify the table structure.

CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGSERIAL       PRIMARY KEY,
    timestamp     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    actor_user_id UUID            REFERENCES users(user_id) ON DELETE SET NULL,
    action        TEXT            NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    details       JSONB           NOT NULL DEFAULT '{}',
    ip_address    INET
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON audit_log(actor_user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action
    ON audit_log(action, timestamp DESC);

-- Revoke UPDATE and DELETE on audit_log from the app runtime user.
-- hakmun_app can INSERT (write events) but cannot alter or remove them.
-- This was granted broadly via ALTER DEFAULT PRIVILEGES in migration 004;
-- we narrow it here for this specific table.
REVOKE UPDATE, DELETE ON audit_log FROM hakmun_app;
