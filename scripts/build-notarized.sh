#!/bin/zsh
# Builds the Developer ID Release app, notarizes and staples it. Prints the path of the app to
# install. The recipe is the one in STATUS.md (2026-09-29): xcodebuild adds get-task-allow, which
# Apple rejects, so the appex and then the app are re-signed with their own entitlements minus
# that key. Do not set CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO (it drops the sandbox too).
# Needs the "Developer ID Application" cert and the notarytool keychain profile `notary`.
set -euo pipefail
cd "${0:A:h}/.."
ID="Developer ID Application: Daniel Decena (877MLS29T9)"
DD="DerivedData/devid"
xcodebuild -project "Claude in Safari/Claude in Safari.xcodeproj" -scheme "Claude in Safari" \
  -configuration Release -derivedDataPath "$DD" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Developer ID Application" DEVELOPMENT_TEAM=877MLS29T9 \
  PROVISIONING_PROFILE_SPECIFIER="" OTHER_CODE_SIGN_FLAGS="--timestamp" build | grep -E " error|BUILD" || true
APP="$PWD/$DD/Build/Products/Release/Claude in Safari.app"
APPEX="$APP/Contents/PlugIns/Claude in Safari Extension.appex"
[ -d "$APPEX" ] || { echo "build produced no appex" >&2; exit 1; }
TMP="$(mktemp -d)"
for t in "$APPEX" "$APP"; do
  codesign -d --entitlements - --xml "$t" > "$TMP/ent.plist" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Delete :com.apple.security.get-task-allow" "$TMP/ent.plist" >/dev/null 2>&1 || true
  grep -q "com.apple.security.app-sandbox" "$TMP/ent.plist" || { echo "sandbox entitlement missing on ${t:t}" >&2; exit 1; }
  codesign --force --options runtime --timestamp --entitlements "$TMP/ent.plist" -s "$ID" "$t"
done
codesign --verify --deep --strict "$APP"
ditto -c -k --keepParent "$APP" "$TMP/app.zip"
xcrun notarytool submit "$TMP/app.zip" --keychain-profile notary --wait | grep -E "id:|status:" | tail -2
xcrun stapler staple "$APP" | tail -1
spctl -a -vv "$APP" 2>&1 | head -2
echo "APP=$APP"
