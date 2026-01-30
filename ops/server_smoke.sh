#!/usr/bin/env bash
# FILE: hakmun-api/ops/server_smoke.sh
# PURPOSE: Smoke test HakMun API (local only). Includes DV2 pins POST+GET checks (contract enforced).

set -euo pipefail

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

http_status() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }

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

TOKEN_BODY="$(curl -sS -X POST "$HAKMUN_API_BASE_URL/v1/dev/smoke-token" -H "X-Smoke-Secret: $SMOKE_TEST_SECRET")"
TOKEN="$(python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("accessToken","") or "")' <<< "$TOKEN_BODY")"
EXPIRES_IN="$(python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("expiresIn","") or "")' <<< "$TOKEN_BODY")"

[[ -n "$TOKEN" ]] || die "Failed to mint token. Response: $(echo "$TOKEN_BODY" | body_prefix)"

echo "✅ Token minted (expiresIn=${EXPIRES_IN}s)"
AUTH_HEADER="Authorization: Bearer $TOKEN"

print_section "2) Smoke endpoints"

hit() {
  local name="$1"
  local url="$2"
  local expect="${3:-200}"
  local code
  code="$(http_status "$url" -H "$AUTH_HEADER")"
  echo "[$code] $name"
  if [[ "$code" != "$expect" ]]; then
    echo "  Body:"
    curl -sS "$url" -H "$AUTH_HEADER" | body_prefix
    echo ""
    return 1
  fi
  echo -n "  OK: "
  curl -sS "$url" -H "$AUTH_HEADER" | body_prefix
  echo ""
}

post_json_expect() {
  local name="$1"
  local url="$2"
  local json_body="$3"
  local expect="${4:-200}"

  local resp_file
  resp_file="$(mktemp)"

  local code
  code="$(curl -sS -o "$resp_file" -w "%{http_code}" -X POST "$url" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    --data-binary "$json_body")"

  echo "[$code] $name"
  if [[ "$code" != "$expect" ]]; then
    echo "  Body:"
    cat "$resp_file" | body_prefix
    echo ""
    rm -f "$resp_file"
    return 1
  fi

  echo -n "  OK: "
  cat "$resp_file" | body_prefix
  echo ""

  rm -f "$resp_file"
  return 0
}

post_reading_item() {
  local text="$1"
  local url="$HAKMUN_API_BASE_URL/v1/reading/items"

  local json_body
  json_body="$(python3 - <<PY
import json
print(json.dumps({"text": """$text""", "unit_type": "sentence", "language": "ko"}))
PY
)"

  local resp_file
  resp_file="$(mktemp)"

  local code
  code="$(curl -sS -o "$resp_file" -w "%{http_code}" -X POST "$url" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    --data-binary "$json_body")"

  echo "[$code] reading create -> POST /v1/reading/items"
  if [[ "$code" != "201" ]]; then
    echo "  Body:"
    cat "$resp_file" | body_prefix
    echo ""
    rm -f "$resp_file"
    return 1
  fi

  echo -n "  OK: "
  cat "$resp_file" | body_prefix
  echo ""
  rm -f "$resp_file"
  return 0
}

hit "whoami -> /v1/session/whoami" "$HAKMUN_API_BASE_URL/v1/session/whoami"
hit "library/global -> /v1/library/global" "$HAKMUN_API_BASE_URL/v1/library/global"
hit "library/review-inbox -> /v1/library/review-inbox" "$HAKMUN_API_BASE_URL/v1/library/review-inbox"
hit "reading coverage -> /v1/reading-items/coverage" "$HAKMUN_API_BASE_URL/v1/reading-items/coverage"
hit "assets list -> /v1/assets" "$HAKMUN_API_BASE_URL/v1/assets"

hit "reading items (personal) -> /v1/reading/items" "$HAKMUN_API_BASE_URL/v1/reading/items"
READING_TEXT="Smoke test reading sentence $(date +%Y-%m-%dT%H:%M:%S)"
post_reading_item "$READING_TEXT"
hit "reading items (personal) after create -> /v1/reading/items" "$HAKMUN_API_BASE_URL/v1/reading/items"

print_section "3) DV2 Dictionary pins"

PIN_HEADWORD="물어보다"
PIN_VOCAB_ID="8388aa27-d13c-4208-b0c1-2ff516dd9604"

PIN_BODY="$(python3 - <<PY
import json
print(json.dumps({"headword": "$PIN_HEADWORD", "vocab_id": "$PIN_VOCAB_ID"}))
PY
)"

post_json_expect "dictionary pins create -> POST /v1/me/dictionary/pins" \
  "$HAKMUN_API_BASE_URL/v1/me/dictionary/pins" \
  "$PIN_BODY" \
  200

PINS_FILE="$(mktemp)"
curl -sS "$HAKMUN_API_BASE_URL/v1/me/dictionary/pins" -H "$AUTH_HEADER" > "$PINS_FILE"

echo "[200] dictionary pins list -> /v1/me/dictionary/pins"
echo -n "  OK: "
cat "$PINS_FILE" | body_prefix
echo ""

if [[ ! -s "$PINS_FILE" ]]; then
  rm -f "$PINS_FILE"
  die "pins list returned empty response"
fi

python3 - <<'PY' "$PINS_FILE"
import json,sys
path=sys.argv[1]
with open(path,"r",encoding="utf-8") as f:
    d=json.load(f)

if not d.get("ok", False):
    raise SystemExit("❌ pins list returned ok=false")

if "build_sha" in d or "first_row_keys" in d:
    raise SystemExit("❌ pins list still contains debug fields (remove build_sha/first_row_keys)")

pins=d.get("pins", []) or []
hw="물어보다"
if not any((p.get("headword")==hw) for p in pins):
    raise SystemExit(f"❌ pins list does not include headword: {hw}")

# Contract enforcement: must not contain old bad keys
for p in pins:
    if "void" in p:
        raise SystemExit("❌ pins list contains bad key: void")
    if "pos_codenknown" in p:
        raise SystemExit("❌ pins list contains bad key: pos_codenknown")
    if "vocab_id" not in p:
        raise SystemExit("❌ pins list missing required key: vocab_id")
    if "pos_code" not in p:
        raise SystemExit("❌ pins list missing required key: pos_code")

print("✅ pins list includes expected headword and contract keys are clean")
PY

rm -f "$PINS_FILE"

print_section "DONE"
echo "✅ Smoke suite complete."