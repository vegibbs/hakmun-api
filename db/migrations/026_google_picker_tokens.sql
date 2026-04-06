-- Migration 026: Create google_picker_tokens table
--
-- Short-lived one-time-use tokens that bridge Bearer auth (API calls)
-- to browser page loads (ASWebAuthenticationSession opens the Picker page).
-- Client gets a page_token via POST /v1/google-picker/token (Bearer auth),
-- then opens GET /v1/google-picker?page_token=... in a browser context.

CREATE TABLE IF NOT EXISTS google_picker_tokens (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(user_id),
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_picker_tokens_user_id
  ON google_picker_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_google_picker_tokens_expires_at
  ON google_picker_tokens (expires_at)
  WHERE used = false;
