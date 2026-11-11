#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
xcrun swiftc "$root/ios/WineRec/Models/DomainModels.swift" "$root/ios/Tests/TasteEvidenceCheck.swift" -o "$tmp/taste-evidence-check"
"$tmp/taste-evidence-check"
