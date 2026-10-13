#!/bin/zsh
# Installs a built app into ~/Applications and makes it the ONLY registered extension provider.
#
# Why this exists: xcodebuild registers the appex it just built (under DerivedData) with
# pluginkit. That displaces the installed copy, so Safari Technology Preview can launch with no
# extension context at all; worse, once both paths are known, each browser loads BOTH copies and
# every tab shows up twice under two contexts with different tab ids (seen 2026-10-13).
#
#   zsh scripts/install-app.sh                                  # installs the Release build
#   zsh scripts/install-app.sh "path/to/Claude in Safari.app"   # installs a specific build
#
# Browsers already running keep the old copy: quit and reopen Safari and STP afterwards.
set -euo pipefail
cd "${0:A:h}/.."
SRC="${1:-$PWD/DerivedData/devid/Build/Products/Release/Claude in Safari.app}"
DEST="$HOME/Applications/Claude in Safari.app"
[ -d "$SRC" ] || { echo "no app at $SRC (run scripts/build-notarized.sh first)" >&2; exit 1; }

# ditto merges into an existing bundle, which breaks the signature; replace it outright.
rm -rf "$DEST"
ditto "$SRC" "$DEST"

# Drop every registration that is not the installed copy, then register that one.
pluginkit -mAvvv -p com.apple.Safari.web-extension 2>/dev/null \
  | grep -A1 "claude-in-safari.Extension" | sed -n 's/^[[:space:]]*Path = //p' \
  | while IFS= read -r p; do
      [ "$p" = "$DEST/Contents/PlugIns/Claude in Safari Extension.appex" ] && continue
      echo "de-registering stale copy: $p"
      pluginkit -r "$p" 2>/dev/null || true
    done
pluginkit -a "$DEST/Contents/PlugIns/Claude in Safari Extension.appex"
open "$DEST"

echo
spctl -a -vv "$DEST" 2>&1 | head -2
echo "registered:"
pluginkit -mAvvv -p com.apple.Safari.web-extension 2>/dev/null \
  | grep -A1 "claude-in-safari.Extension" | sed -n 's/^[[:space:]]*Path = /  /p'
echo
echo "Now quit and reopen Safari and Safari Technology Preview."
echo "Check: each browser should report ONE context (duplicate rows in Settings > Extensions mean a stale copy is still registered)."
