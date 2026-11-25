#!/usr/bin/env bash
# The worker/ deploy bundle carries copies of code that lives in main/.
# This checks that the copies have not drifted.
#
#   shared/scripts/check-worker-sync.sh          # report drift, exit 1 if any
#   shared/scripts/check-worker-sync.sh --write  # copy main/ over worker/ to fix it
#
# main/ is the source of truth: it is the only side with tests.
# Test files, test helpers, build output and node_modules are not synced.
set -euo pipefail

cd "$(dirname "$0")/../.."

write=false
if [[ "${1:-}" == "--write" ]]; then
  write=true
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--write]" >&2
  exit 2
fi

# Directory pairs synced recursively (main path -> worker path).
dirs=(src packages)
# Individual files synced (worker/ deploys only these API routes).
files=(api/chunk-worker.ts api/worker-failure.ts)

excludes=(
  --exclude=node_modules
  --exclude=dist
  --exclude='*.tsbuildinfo'
  --exclude='*.test.ts'
  --exclude=test-support
)

drift=0

# List synced files under a directory, relative to it (portable: no rsync).
list_synced() {
  (cd "$1" && find . \
    \( -name node_modules -o -name dist -o -name test-support \) -prune -o \
    -type f ! -name '*.test.ts' ! -name '*.tsbuildinfo' -print | sort)
}

for dir in "${dirs[@]}"; do
  if $write; then
    # Remove worker files that no longer exist in main, then copy main over.
    comm -13 <(list_synced "main/$dir") <(list_synced "worker/$dir") |
      while IFS= read -r rel; do rm "worker/$dir/$rel"; done
    list_synced "main/$dir" | while IFS= read -r rel; do
      mkdir -p "$(dirname "worker/$dir/$rel")"
      cp "main/$dir/$rel" "worker/$dir/$rel"
    done
  elif ! diff -r "${excludes[@]}" "main/$dir" "worker/$dir"; then
    drift=1
  fi
done

for file in "${files[@]}"; do
  if $write; then
    cp "main/$file" "worker/$file"
  elif ! diff -u "main/$file" "worker/$file"; then
    drift=1
  fi
done

if $write; then
  echo "worker/ synced from main/. Review with: git status worker/"
  exit 0
fi

if [[ $drift -ne 0 ]]; then
  echo >&2
  echo "worker/ has drifted from main/ (see diff above)." >&2
  echo "Make the change in main/, then run: shared/scripts/check-worker-sync.sh --write" >&2
  exit 1
fi

echo "worker/ matches main/."
