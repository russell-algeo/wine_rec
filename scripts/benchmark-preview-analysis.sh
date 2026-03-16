#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

PYTHON_BIN="$(command -v python3 || command -v python || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "python3 or python is required" >&2
  exit 1
fi

BASE_URL="${BASE_URL:-}"
FILE_PATH="${FILE_PATH:-}"
INPUT_URL="${INPUT_URL:-}"
SHARE_URL="${SHARE_URL:-}"
LABEL="${LABEL:-benchmark}"
OUT_DIR="${OUT_DIR:-$(pwd)/tmp/benchmarks}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-1}"

if [[ -z "$BASE_URL" ]]; then
  echo "BASE_URL is required" >&2
  exit 1
fi

if [[ -z "$FILE_PATH" && -z "$INPUT_URL" ]]; then
  echo "Either FILE_PATH or INPUT_URL is required" >&2
  exit 1
fi

if [[ -n "$FILE_PATH" && -n "$INPUT_URL" ]]; then
  echo "Provide only one of FILE_PATH or INPUT_URL" >&2
  exit 1
fi

if [[ -n "$FILE_PATH" && ! -f "$FILE_PATH" ]]; then
  echo "FILE_PATH does not exist: $FILE_PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

timestamp_slug="$("$PYTHON_BIN" - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
PY
)"

safe_label="$("$PYTHON_BIN" - "$LABEL" <<'PY'
import re
import sys
label = sys.argv[1]
normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-")
print(normalized or "benchmark")
PY
)"

cookie_jar="$OUT_DIR/${safe_label}-${timestamp_slug}.cookies.txt"
create_response_path="$OUT_DIR/${safe_label}-${timestamp_slug}.create.json"
analysis_response_path="$OUT_DIR/${safe_label}-${timestamp_slug}.analysis.json"
result_path="$OUT_DIR/${safe_label}-${timestamp_slug}.result.json"

now_ms() {
  "$PYTHON_BIN" - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

if [[ -n "$SHARE_URL" ]]; then
  curl -sSL \
    -c "$cookie_jar" \
    "$SHARE_URL" \
    -o /dev/null
fi

request_started_ms="$(now_ms)"

if [[ -n "$INPUT_URL" ]]; then
  create_payload="$(jq -cn --arg url "$INPUT_URL" '{url: $url}')"
  create_response="$(
    curl -sS \
      -b "$cookie_jar" \
      -c "$cookie_jar" \
      -X POST \
      "$BASE_URL/api/urls" \
      -H 'content-type: application/json' \
      --data "$create_payload"
  )"
  source_value="$INPUT_URL"
  source_mode="url"
else
  create_response="$(
    curl -sS \
      -b "$cookie_jar" \
      -c "$cookie_jar" \
      -X POST \
      "$BASE_URL/api/uploads" \
      -F "file=@$FILE_PATH"
  )"
  source_value="$FILE_PATH"
  source_mode="upload"
fi

printf '%s\n' "$create_response" > "$create_response_path"

analysis_id="$(printf '%s\n' "$create_response" | jq -r '.analysisId // empty')"
if [[ -z "$analysis_id" ]]; then
  echo "Failed to create analysis" >&2
  cat "$create_response_path" >&2
  exit 1
fi

terminal_status=""
while [[ -z "$terminal_status" ]]; do
  analysis_response="$(
    curl -sS \
      -b "$cookie_jar" \
      "$BASE_URL/api/analyses/$analysis_id"
  )"
  printf '%s\n' "$analysis_response" > "$analysis_response_path"

  status="$(printf '%s\n' "$analysis_response" | jq -r '.status')"
  case "$status" in
    completed|failed|canceled)
      terminal_status="$status"
      ;;
    *)
      sleep "$POLL_INTERVAL_SECONDS"
      ;;
  esac
done

request_finished_ms="$(now_ms)"

result_json="$(
  "$PYTHON_BIN" - "$analysis_response_path" "$request_started_ms" "$request_finished_ms" "$BASE_URL" "$source_value" "$source_mode" "$safe_label" <<'PY'
import json
import sys
from datetime import datetime

analysis_path, started_ms, finished_ms, base_url, source_value, source_mode, label = sys.argv[1:8]
started_ms = int(started_ms)
finished_ms = int(finished_ms)

with open(analysis_path, "r", encoding="utf-8") as handle:
    analysis = json.load(handle)

def parse_iso(value: str) -> datetime:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)

created_at = analysis.get("createdAt")
updated_at = analysis.get("updatedAt")
server_duration_ms = None
if created_at and updated_at:
    server_duration_ms = int((parse_iso(updated_at) - parse_iso(created_at)).total_seconds() * 1000)

recommendations = analysis.get("recommendations") or []
matched_count = sum(1 for item in recommendations if item.get("status") == "matched")
low_confidence_count = sum(1 for item in recommendations if item.get("status") == "low-confidence")
unmatched_count = sum(1 for item in recommendations if item.get("status") == "unmatched")

result = {
    "label": label,
    "baseUrl": base_url,
    "sourceMode": source_mode,
    "sourceValue": source_value,
    "analysisId": analysis.get("id"),
    "status": analysis.get("status"),
    "errorMessage": analysis.get("errorMessage"),
    "createdAt": created_at,
    "updatedAt": updated_at,
    "wallClockMs": finished_ms - started_ms,
    "serverDurationMs": server_duration_ms,
    "candidateCount": len(analysis.get("candidates") or []),
    "recommendationCount": len(recommendations),
    "matchedCount": matched_count,
    "lowConfidenceCount": low_confidence_count,
    "unmatchedCount": unmatched_count,
    "sourceType": analysis.get("sourceType"),
    "sourceFilename": analysis.get("sourceFilename"),
}

print(json.dumps(result, indent=2))
PY
)"

printf '%s\n' "$result_json" > "$result_path"
printf '%s\n' "$result_json"
echo "Saved benchmark result to $result_path" >&2
