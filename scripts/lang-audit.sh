#!/usr/bin/env bash
# lang-audit.sh — fails if any protected literal's bytes changed vs baseline.
# Ranges file: scripts/protected-ranges.txt, lines "path:start:end".
set -euo pipefail
RANGES=scripts/protected-ranges.txt
BASE=scripts/protected-hashes.txt
tmp=$(mktemp)
while IFS=: read -r f s e; do
  [ -z "$f" ] && continue
  h=$(sed -n "${s},${e}p" "$f" | sha256sum | cut -d' ' -f1)
  echo "$f:$s:$e $h" >> "$tmp"
done < "$RANGES"
if [ "${1:-}" = "--baseline" ]; then mv "$tmp" "$BASE"; echo "baseline written"; exit 0; fi
if ! diff -u "$BASE" "$tmp"; then
  echo "PROTECTED-STRING VIOLATION — a frozen literal's bytes changed"; rm -f "$tmp"; exit 1
fi
rm -f "$tmp"; echo "protected-string audit: clean"
