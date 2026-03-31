#!/usr/bin/env bash
# test_content_analyze.sh — API contract tests for /v1/content/analyze endpoints
#
# Usage:
#   HAKMUN_API=https://hakmun-api-sandbox.up.railway.app AUTH_TOKEN=xxx bash ops/test_content_analyze.sh
#
# Requires jq for JSON parsing.

set -euo pipefail

API="${HAKMUN_API:-https://hakmun-api-sandbox.up.railway.app}"
TOKEN="${AUTH_TOKEN:?AUTH_TOKEN must be set}"
PASS=0
FAIL=0

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $label (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — expected HTTP $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_json() {
  local label="$1" jq_expr="$2" body="$3"
  local val
  val=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null || echo "__JQ_FAIL__")
  if [ "$val" != "null" ] && [ "$val" != "__JQ_FAIL__" ] && [ -n "$val" ]; then
    echo "  ✓ $label → $val"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — jq '$jq_expr' returned: $val"
    FAIL=$((FAIL + 1))
  fi
}

echo "═══ Content Analyze API Contract Tests ═══"
echo "Target: $API"
echo ""

# ── Test 1: POST /v1/content/analyze — happy path ──
echo "Test 1: Analyze valid Korean text"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/v1/content/analyze" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"오늘 날씨가 좋아서 공원에 갔어요. 아이스크림을 먹었습니다.","source_type":"hakdoc","import_as":"all"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "analyze happy path" "200" "$HTTP"
assert_json "ok is true" ".ok" "$BODY"
assert_json "preview.sentences exists" ".preview.sentences | length" "$BODY"

# ── Test 2: POST /v1/content/analyze — empty text ──
echo ""
echo "Test 2: Analyze with empty text"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/v1/content/analyze" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"","source_type":"hakdoc"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "empty text rejected" "400" "$HTTP"
assert_json "error is TEXT_REQUIRED" ".error" "$BODY"

# ── Test 3: POST /v1/content/analyze — no auth ──
echo ""
echo "Test 3: Analyze without auth"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/v1/content/analyze" \
  -H "Content-Type: application/json" \
  -d '{"text":"테스트"}')
HTTP=$(echo "$RESP" | tail -1)
assert_status "no auth rejected" "401" "$HTTP"

# ── Test 4: POST /v1/content/analyze/commit — nothing to commit ──
echo ""
echo "Test 4: Commit with empty arrays"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/v1/content/analyze/commit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source_type":"hakdoc","vocabulary":[],"sentences":[],"patterns":[],"fragments":[]}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "empty commit rejected" "400" "$HTTP"
assert_json "error is NOTHING_TO_COMMIT" ".error" "$BODY"

# ── Test 5: POST /v1/content/analyze/commit — one sentence ──
echo ""
echo "Test 5: Commit one sentence"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/v1/content/analyze/commit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source_type":"hakdoc","source_id":null,"document_title":"Test HakDoc","sentences":[{"ko":"테스트 문장입니다","gloss":"This is a test sentence"}],"vocabulary":[],"patterns":[],"fragments":[]}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "commit one sentence" "201" "$HTTP"
assert_json "ok is true" ".ok" "$BODY"
assert_json "document_id present" ".document_id" "$BODY"

# ── Test 6: POST /v1/content/analyze/generate-practice ──
echo ""
echo "Test 6: Generate practice (count=2)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/v1/content/analyze/generate-practice" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selected_text":"오늘 학교에서 한국어를 배웠어요. 선생님이 새로운 문법을 가르쳐 주셨습니다.","source_type":"hakdoc","count":2,"perspective":"first_person","politeness":"해요체","auto_import":false}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "generate practice" "200" "$HTTP"
assert_json "ok is true" ".ok" "$BODY"
assert_json "practice_sentences array" ".practice_sentences | length" "$BODY"

# ── Summary ──
echo ""
echo "═══ Results: $PASS passed, $FAIL failed ═══"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
