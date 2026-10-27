#!/bin/sh
# Writes extension/token.js (gitignored) with a fresh random CIS_TOKEN unless a valid one exists.
# The token is the only thing that stops another local process from dialing the bridge and
# driving logged-in tabs, so it must never be committed: the repo is public.
#   sh scripts/make-token.sh            create if missing or malformed
#   sh scripts/make-token.sh --rotate   replace it (then rebuild, reinstall, restart the bridge)
set -eu
cd "$(dirname "$0")/.."
f=extension/token.js
case "${1:-}" in ""|--rotate) ;; *) echo "usage: make-token.sh [--rotate]" >&2; exit 2 ;; esac
if [ "${1:-}" != "--rotate" ] && grep -Eq '^const CIS_TOKEN = "[A-Za-z0-9_]{32}";$' "$f" 2>/dev/null; then exit 0; fi
t=$(openssl rand -hex 16)
[ "${#t}" -eq 32 ] || { echo "openssl gave no usable token" >&2; exit 1; }
umask 077
printf 'const CIS_TOKEN = "%s";\n' "$t" > "$f.new"
mv "$f.new" "$f"
echo "wrote $f"
