#!/usr/bin/env bash
set -euo pipefail

# HakMun API — One-shot Smoke Test for Server Organization Epic
# - Repo guardrail (refuses to run in the wrong repo)
# - Loads secrets from a local .env file (NOT committed)
# - Mints a smoke access token
# - Hits the core endpoints you care about after each refactor commit
#
# Usage:
#   ./ops/server_smoke.sh
#
# Optional env overrides:
#   HAKMUN_API_BASE_URL="https://..." ./ops/server_smoke.sh
#   ENV_FILE="/path/to/.env" ./ops/server_smoke.sh

# -----------------------------
# CONFIG
# -----------------------------
EXPECTED_REMOTE_SUBSTR="vegibbs/hakmun-api.git"
DEFAULT_ENV_FILE="/Users/vernongibbs/Documents/DevProjects/IdeaVault/VGC/.env"
ENV_FILE="${ENV_FILE:-$DEFAULT_ENV_FILE}"

# -----------------------------
# Guardrail: must be in hakmun-api repo
# -----------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "❌ git not found"
  exit 1
fi

REMOTE_LINE="$(git remote -v 2>/dev/null | head -n 1 || true)"
if [[ -z "$REMOTE_LINE" || "$REMOTE_LINE" != *"$EXPECTED_REMOTE_SUBSTR"* ]]; then
  echo "❌ Wrong repo (or not a git repo)."
  echo "   Expected remote to contain: $EXPECTED_REMOTE_SUBSTR"
  echo "   Detected: ${REMOTE_LINE:-<none>}"
  exit 1
fi

# -----------------------------
# Load .env (no export of everything; only what we need)
# -----------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ ENV file not found: $ENV_FILE"
  exit 1
fi

# Extract KEY=VALUE from .env safely (no comments, no blanks)
get_env_value() {
  local key="$1"
  # shellcheck disable=SC2002
  cat "$ENV_FILE" \
    | sed -e 's/\r$//' \
    | grep -E "^[[:space:]]*$key=" \
    | tail -n 1 \
    | sed -E "s/^[[:space:]]*$key=//"
}

# Prefer shell env overrides if set; else use .env
HAKMUN_API_BASE_URL="${HAKMUN_API_BASE_URL:-$(get_env_value HAKMUN_API_BASE_URL)}"
SMOKE_TEST_SECRET="${SMOKE_TEST_SECRET:-$(get_env_value SMOKE_TEST_SECRET)}"

if [[ -z "${HAKMUN_API_BASE_URL:-}" ]]; then
  echo "❌ HAKMUN_API_BASE_URL not set (env or .env)."
  echo "   Add to $ENV_FILE: HAKMUN_API_BASE_URL=https://your-railway-url"
  exit 1
fi

if [[ -z "${SMOKE_TEST_SECRET:-}" ]]; then
  echo "❌ SMOKE_TEST_SECRET not set (env or .env)."
  echo "   Add to $ENV_FILE: SMOKE_TEST_SECRET=..."
  exit 1
fi

# Normalize base URL (strip trailing slash)
HAKMUN_API_BASE_URL="${HAKMUN_API_BASE_URL%/}"

# -----------------------------
# Helpers
# -----------------------------
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "❌ missing command: $1"; exit 1; }
}

need_cmd curl
need_cmd python3

json_get() {
  # Reads JSON from stdin, prints value for key, or empty string.
  local key="$1"
  python3 - "$key" <<'PY'
import sys, json
key = sys.argv[1]
try:
    data = json.load(sys.stdin)
    v = data.get(key, "")
    if v is None:
        v = ""
    print(v)
except Exception:
    print("")
PY
}

http_status() {
  # curl args... -> prints status code
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

curl_json() {
  # curl args... -> prints body (no status)
  curl -s "$@"
}

print_section() {
  echo ""
  echo "=============================="
  echo "$1"
  echo "=============================="
}

# -----------------------------
# Step 1: Mint smoke token
# -----------------------------
print_section "1) Mint smoke access token"

TOKEN_BODY="$(curl_json -X POST "$HAKMUN_API_BASE_URL/v1/dev/smoke-token" -H "X-Smoke-Secret: $SMOKE_TEST_SECRET")"
TOKEN="$(printf "%s" "$TOKEN_BODY" | json_get accessToken)"
EXPIRES_IN="$(printf "%s" "$TOKEN_BODY" | json_get expiresIn)"

if [[ -z "$TOKEN" ]]; then
  echo "❌ Failed to mint token."
  echo "   Response body was:"
  echo "   $TOKEN_BODY"
  echo ""
  echo "   Quick checks:"
  echo "   - Does server have POST /v1/dev/smoke-token deployed?"
  echo "   - ENABLE_SMOKE_TOKEN=1 set in Railway?"
  echo "   - SMOKE_TEST_SECRET matches Railway?"
  exit 1
fi

echo "✅ Token minted (expiresIn=${EXPIRES_IN:-?}s). Prefix: ${TOKEN:0:18}..."

AUTH_HEADER="Authorization: Bearer $TOKEN"

# -----------------------------
# Step 2: Smoke endpoints
# -----------------------------
print_section "2) Smoke endpoints"

hit() {
  local name="$1"
  local url="$2"
  local want_json="${3:-yes}"

  local code
  code="$(http_status "$url" -H "$AUTH_HEADER")"
  echo "[$code] $name -> $url"

  # Show body for non-200, or for key endpoints (brief)
  if [[ "$code" != "200" ]]; then
    echo "  Body:"
    curl -s "$url" -H "$AUTH_HEADER" | head -c 800
    echo ""
    return 1
  fi

  if [[ "$want_json" == "yes" ]]; then
    # show small snippet to confirm shape without noise
    local body
    body="$(curl -s "$url" -H "$AUTH_HEADER")"
    echo "  OK (body prefix): $(echo "$body" | tr '\n' ' ' | head -c 160)..."
  fi

  return 0
}

# Core session/auth
hit "whoami" "$HAKMUN_API_BASE_URL/v1/session/whoami"

# Registry
hit "library/global" "$HAKMUN_API_BASE_URL/v1/library/global"
hit "library/review-inbox" "$HAKMUN_API_BASE_URL/v1/library/review-inbox"

# Reading coverage (registry gated)
hit "reading-items/coverage" "$HAKMUN_API_BASE_URL/v1/reading-items/coverage"

# Assets list
hit "assets (list)" "$HAKMUN_API_BASE_URL/v1/assets"

print_section "DONE"
echo "✅ Smoke suite complete."
echo "Tip: rerun this after each server refactor commit."