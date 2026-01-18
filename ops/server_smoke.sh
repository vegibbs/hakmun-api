#!/usr/bin/env bash
set -euo pipefail

# Ensure we end in repo root (not wherever script was invoked)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "❌ Unable to determine repo root"
  exit 1
fi

cd "$REPO_ROOT"

cleanup() {
  cd "$REPO_ROOT"
}
trap cleanup EXIT

# HakMun API — One-shot Smoke Test (Server Refactor Safety Net)
#
# Loads from ENV_FILE (default) or shell env overrides:
#   HAKMUN_API_BASE_URL
#   SMOKE_TEST_SECRET
#
# Usage:
#   ./ops/server_smoke.sh
#
# Optional:
#   ENV_FILE="/path/to/.env" ./ops/server_smoke.sh

EXPECTED_REMOTE_SUBSTR="vegibbs/hakmun-api.git"
DEFAULT_ENV_FILE="/Users/vernongibbs/Documents/DevProjects/IdeaVault/VGC/.env"
ENV_FILE="${ENV_FILE:-$DEFAULT_ENV_FILE}"

die() { echo "❌ $1"; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

print_section() {
  echo ""
  echo "=============================="
  echo "$1"
  echo "=============================="
}

trim_quotes() {
  local s="$1"
  s="${s%\"}"; s="${s#\"}"
  s="${s%\'}"; s="${s#\'}"
  echo "$s"
}

get_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^[[:space:]]*$key=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -z "$line" ]] && echo "" && return
  echo "${line#*=}"
}

body_prefix() {
  python3 -c 'import sys; t=sys.stdin.read().replace("\n"," ").replace("\r"," "); print((t[:220] + ("..." if len(t)>220 else "")))'
}

http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# ---------- start ----------
need_cmd git
need_cmd curl
need_cmd python3

REMOTE_LINE="$(git remote -v 2>/dev/null | head -n 1 || true)"
[[ -n "$REMOTE_LINE" ]] || die "not a git repo. Run inside hakmun-api."
[[ "$REMOTE_LINE" == *"$EXPECTED_REMOTE_SUBSTR"* ]] || die "wrong repo. Detected: ${REMOTE_LINE:-<none>}"

[[ -f "$ENV_FILE" ]] || die "ENV file not found: $ENV_FILE"

HAKMUN_API_BASE_URL="${HAKMUN_API_BASE_URL:-$(get_env_value HAKMUN_API_BASE_URL)}"
SMOKE_TEST_SECRET="${SMOKE_TEST_SECRET:-$(get_env_value SMOKE_TEST_SECRET)}"

HAKMUN_API_BASE_URL="$(trim_quotes "$HAKMUN_API_BASE_URL")"
SMOKE_TEST_SECRET="$(trim_quotes "$SMOKE_TEST_SECRET")"

[[ -n "$HAKMUN_API_BASE_URL" ]] || die "HAKMUN_API_BASE_URL not set (env or $ENV_FILE)."
[[ -n "$SMOKE_TEST_SECRET" ]] || die "SMOKE_TEST_SECRET not set (env or $ENV_FILE)."

HAKMUN_API_BASE_URL="${HAKMUN_API_BASE_URL%/}"

print_section "1) Mint smoke access token"

TOKEN_BODY="$(curl -s -X POST "$HAKMUN_API_BASE_URL/v1/dev/smoke-token" -H "X-Smoke-Secret: $SMOKE_TEST_SECRET")"

TOKEN="$(python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("accessToken","") or "")' <<< "$TOKEN_BODY")"
EXPIRES_IN="$(python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("expiresIn","") or "")' <<< "$TOKEN_BODY")"

[[ -n "$TOKEN" ]] || die "failed to mint token. Response: $(echo "$TOKEN_BODY" | body_prefix)"

echo "✅ Token minted (expiresIn=${EXPIRES_IN:-?}s). Prefix: ${TOKEN:0:18}..."

AUTH_HEADER="Authorization: Bearer $TOKEN"

print_section "2) Smoke endpoints"

hit() {
  local name="$1"
  local url="$2"
  local code
  code="$(http_status "$url" -H "$AUTH_HEADER")"
  echo "[$code] $name"
  if [[ "$code" != "200" ]]; then
    echo "  Body:"
    curl -s "$url" -H "$AUTH_HEADER" | body_prefix
    echo ""
    return 1
  fi
  echo -n "  OK: "
  curl -s "$url" -H "$AUTH_HEADER" | body_prefix
  echo ""
}

hit "whoami -> /v1/session/whoami" "$HAKMUN_API_BASE_URL/v1/session/whoami"
hit "library/global -> /v1/library/global" "$HAKMUN_API_BASE_URL/v1/library/global"
hit "library/review-inbox -> /v1/library/review-inbox" "$HAKMUN_API_BASE_URL/v1/library/review-inbox"
hit "reading coverage -> /v1/reading-items/coverage" "$HAKMUN_API_BASE_URL/v1/reading-items/coverage"
hit "assets list -> /v1/assets" "$HAKMUN_API_BASE_URL/v1/assets"

print_section "DONE"
echo "✅ Smoke suite complete."