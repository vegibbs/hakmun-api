#!/usr/bin/env bash
# db/migrate.sh — Run pending SQL migrations against the HakMun database.
#
# Usage:
#   ./db/migrate.sh <DATABASE_URL>
#
# Or via Railway (from the hakmun-api project root, linked to Postgres service):
#   railway run -- bash db/migrate.sh '$DATABASE_PUBLIC_URL'
#
# What it does:
#   1. Reads numbered SQL files from db/migrations/ (NNN_name.sql)
#   2. Checks schema_change_log to see which have already been applied
#   3. Runs each pending migration in order inside a transaction
#   4. Logs the result to schema_change_log with script_no, name, sha256, git commit
#
# The schema_change_log table must already exist (script 100).

set -euo pipefail

PSQL="/opt/homebrew/opt/libpq/bin/psql"
MIGRATIONS_DIR="$(dirname "$0")/migrations"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <DATABASE_URL>"
  exit 1
fi

DB_URL="$1"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "No migrations directory found at $MIGRATIONS_DIR"
  exit 1
fi

# Get the current git commit (short hash) for provenance
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Collect all migration files sorted by number
PENDING=0
APPLIED=0
FAILED=0

for sql_file in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  filename=$(basename "$sql_file")

  # Extract script number from filename (e.g., 219 from 219_add_session_date.sql)
  script_no=$(echo "$filename" | grep -oE '^[0-9]+' || true)
  if [ -z "$script_no" ]; then
    echo "SKIP  $filename (no leading number)"
    continue
  fi

  # Check if already applied
  already=$($PSQL "$DB_URL" -tAc "SELECT COUNT(*) FROM schema_change_log WHERE script_no = $script_no;" 2>/dev/null)
  if [ "$already" -gt 0 ]; then
    APPLIED=$((APPLIED + 1))
    continue
  fi

  # Compute SHA-256 of the file
  sha256=$(shasum -a 256 "$sql_file" | awk '{print $1}')

  echo "APPLY $filename (script_no=$script_no) ..."

  # Run migration inside a transaction
  if $PSQL "$DB_URL" -v ON_ERROR_STOP=1 -1 -f "$sql_file" 2>&1; then
    # Log to schema_change_log
    $PSQL "$DB_URL" -c "INSERT INTO schema_change_log (script_no, script_name, script_sha256, git_commit)
      VALUES ($script_no, '$filename', '$sha256', '$GIT_COMMIT')
      ON CONFLICT (script_no) DO NOTHING;" 2>&1

    echo "  OK  $filename"
    PENDING=$((PENDING + 1))
  else
    echo "FAIL  $filename"
    FAILED=$((FAILED + 1))
    exit 1
  fi
done

echo ""
echo "Done. Already applied: $APPLIED, Newly applied: $PENDING, Failed: $FAILED"
