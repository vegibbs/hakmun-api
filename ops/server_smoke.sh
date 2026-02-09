#!/usr/bin/env bash
# FILE: hakmun-api/ops/server_smoke.sh
# PURPOSE: Smoke test HakMun API (local only).
# - Baseline: whoami, library, assets
# - Canonical content items: list + create + coverage (NO /v1/reading/*)
# - DV2 dictionary pins (POST + GET + DELETE + GET)
# - D2.1 google doc parse-link (valid + invalid)

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

# -------------------------------------------------------------------
# 🔒 INVARIANT: ALWAYS PRINT ACCESS TOKEN
# -------------------------------------------------------------------
echo "✅ Token minted (expiresIn=${EXPIRES_IN}s)"
echo "TOKEN=$TOKEN"
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

# Negative: /v1/reading must not exist
hit "reading items must be gone -> /v1/reading/items" \
  "$HAKMUN_API_BASE_URL/v1/reading/items" \
  404

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

delete_json_expect() {
  local name="$1"
  local url="$2"
  local json_body="$3"
  local expect="${4:-200}"

  local resp_file
  resp_file="$(mktemp)"

  local code
  code="$(curl -sS -o "$resp_file" -w "%{http_code}" -X DELETE "$url" \
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

# Baseline endpoints
hit "whoami -> /v1/session/whoami" "$HAKMUN_API_BASE_URL/v1/session/whoami"
hit "library/global -> /v1/library/global" "$HAKMUN_API_BASE_URL/v1/library/global"
hit "library/review-inbox -> /v1/library/review-inbox" "$HAKMUN_API_BASE_URL/v1/library/review-inbox"
hit "assets list -> /v1/assets" "$HAKMUN_API_BASE_URL/v1/assets"

# Canonical content items (sentences)
hit "content items (sentences) -> /v1/content/items?content_type=sentence" \
  "$HAKMUN_API_BASE_URL/v1/content/items?content_type=sentence"

CONTENT_TEXT="Smoke test sentence $(date +%Y-%m-%dT%H:%M:%S)"
CONTENT_BODY="$(python3 - <<PY
import json
print(json.dumps({
  "content_type": "sentence",
  "text": "$CONTENT_TEXT"
}))
PY
)"

post_json_expect "content item create -> POST /v1/content/items" \
  "$HAKMUN_API_BASE_URL/v1/content/items" \
  "$CONTENT_BODY" \
  201

hit "content items (sentences) after create -> /v1/content/items?content_type=sentence" \
  "$HAKMUN_API_BASE_URL/v1/content/items?content_type=sentence"

hit "content coverage (sentences) -> /v1/content/items/coverage?content_type=sentence" \
  "$HAKMUN_API_BASE_URL/v1/content/items/coverage?content_type=sentence"

print_section "3) DV2 Dictionary pins (POST + GET + DELETE + GET)"

PIN_HEADWORD="물어보다"
PIN_VOCAB_ID="8388aa27-d13c-4208-b0c1-2ff516dd9604"

PIN_BODY="$(python3 - <<PY
import json
print(json.dumps({"headword": "$PIN_HEADWORD", "vocab_id": "$PIN_VOCAB_ID"}))
PY
)"

UNPIN_BODY="$(python3 - <<PY
import json
print(json.dumps({"headword": "$PIN_HEADWORD"}))
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

python3 - <<'PY' "$PINS_FILE"
import json,sys
path=sys.argv[1]
with open(path,"r",encoding="utf-8") as f:
    d=json.load(f)
pins=d.get("pins", []) or []
hw="물어보다"
if not any((p.get("headword")==hw) for p in pins):
    raise SystemExit("❌ pins list did not include headword after pin")
print("✅ pins include headword after pin")
PY
rm -f "$PINS_FILE"

delete_json_expect "dictionary pins delete -> DELETE /v1/me/dictionary/pins" \
  "$HAKMUN_API_BASE_URL/v1/me/dictionary/pins" \
  "$UNPIN_BODY" \
  200

PINS_FILE2="$(mktemp)"
curl -sS "$HAKMUN_API_BASE_URL/v1/me/dictionary/pins" -H "$AUTH_HEADER" > "$PINS_FILE2"
echo "[200] dictionary pins list after delete -> /v1/me/dictionary/pins"
echo -n "  OK: "
cat "$PINS_FILE2" | body_prefix
echo ""

python3 - <<'PY' "$PINS_FILE2"
import json,sys
path=sys.argv[1]
with open(path,"r",encoding="utf-8") as f:
    d=json.load(f)
pins=d.get("pins", []) or []
hw="물어보다"
if any((p.get("headword")==hw) for p in pins):
    raise SystemExit("❌ pins list still includes headword after delete")
print("✅ pins do not include headword after delete")
PY
rm -f "$PINS_FILE2"


print_section "D2.2 Generic chunked text ingest (highlight text)"

CHUNK_TEXT="This is a smoke-test paragraph one. It has a few sentences.\n\nThis is paragraph two, which should end up in a second chunk if the limit is low enough."

CHUNK_BODY="$(python3 - <<PY
import json
print(json.dumps({
  "source_kind": "google_doc",
  "source_uri": "smoke://google-doc-highlight",
  "import_as": "sentences",
  "scope": {"mode": "highlight"},
  "selected_text": "$CHUNK_TEXT",
  "chunk_max_chars": 60
}))
PY
)"

post_json_expect "ingest-text-chunked (highlight) -> POST /v1/documents/ingest-text-chunked" \
  "$HAKMUN_API_BASE_URL/v1/documents/ingest-text-chunked" \
  "$CHUNK_BODY" \
  201

print_section "D2.1 Google Doc link parsing"

GOOGLE_DOC_TEST_URL="https://docs.google.com/document/d/1FrIT9TNohI9zQfZJkkmqfSyggjqIkMZWuUpIchhso2k/edit?tab=t.0#heading=h.54h6p8qdtiql"

GOOD_BODY="$(python3 - <<PY
import json
print(json.dumps({"google_doc_url": "$GOOGLE_DOC_TEST_URL"}))
PY
)"

post_json_expect "google parse-link (valid) -> POST /v1/documents/google/parse-link" \
  "$HAKMUN_API_BASE_URL/v1/documents/google/parse-link" \
  "$GOOD_BODY" \
  200

GOOD_FILE="$(mktemp)"
curl -sS -X POST "$HAKMUN_API_BASE_URL/v1/documents/google/parse-link" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  --data-binary "$GOOD_BODY" > "$GOOD_FILE"

python3 - <<'PY' "$GOOD_FILE"
import json,sys
path=sys.argv[1]
with open(path,"r",encoding="utf-8") as f:
    d=json.load(f)
assert d.get("ok") is True, d
fid=d.get("file_id","")
assert isinstance(fid,str) and len(fid) >= 20, d
print("✅ valid Google Doc link parsed")
PY
rm -f "$GOOD_FILE"

BAD_URL="https://example.com/not-a-doc"
BAD_BODY="$(python3 - <<PY
import json
print(json.dumps({"google_doc_url": "$BAD_URL"}))
PY
)"

RESP_BAD="$(mktemp)"
CODE_BAD="$(curl -sS -o "$RESP_BAD" -w "%{http_code}" -X POST "$HAKMUN_API_BASE_URL/v1/documents/google/parse-link" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  --data-binary "$BAD_BODY")"

echo "[$CODE_BAD] google parse-link (invalid) -> POST /v1/documents/google/parse-link"
echo -n "  OK: "
cat "$RESP_BAD" | body_prefix
echo ""

if [[ "$CODE_BAD" != "400" ]]; then
  echo "  Body:"
  cat "$RESP_BAD" | body_prefix
  echo ""
  rm -f "$RESP_BAD"
  die "Expected 400 for invalid google doc link"
fi

python3 - <<'PY' "$RESP_BAD"
import json,sys
path=sys.argv[1]
with open(path,"r",encoding="utf-8") as f:
    d=json.load(f)
assert d.get("ok") is False, d
assert d.get("error") == "INVALID_GOOGLE_DOC_LINK", d
print("✅ invalid Google Doc link rejected")
PY
rm -f "$RESP_BAD"

print_section "DONE"
echo "✅ Smoke suite complete."