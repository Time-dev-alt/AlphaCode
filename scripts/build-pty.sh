#!/usr/bin/env bash
# Build the optional PTY helper. Falls back gracefully when no C compiler ships.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="${1:-$root/data/bin/ptyhelper}"
mkdir -p "$(dirname "$out")"
cc_bin="${CC:-}"
if [ -z "$cc_bin" ]; then
  for c in cc gcc clang; do
    if command -v "$c" >/dev/null 2>&1; then cc_bin="$c"; break; fi
  done
fi
if [ -z "$cc_bin" ]; then
  echo "no C compiler found — AlphaCode will use the script(1) PTY fallback"
  exit 0
fi
"$cc_bin" -O2 -Wall -Wextra -o "$out" "$root/native/ptyhelper.c" 2>&1 | sed 's/^/[pty] /'
chmod +x "$out"
echo "built $out"
