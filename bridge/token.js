// Reads the shared secret from extension/token.js (gitignored; sh scripts/make-token.sh
// creates it). The bridge, bench.js and the tests all take it from here.
import { readFileSync } from "node:fs";

export const TOKEN = (() => {
  try {
    return readFileSync(new URL("../extension/token.js", import.meta.url), "utf8").match(/^const CIS_TOKEN = "(\w{32})"/m)?.[1];
  } catch {}
})();
if (!TOKEN) throw new Error("no CIS_TOKEN in extension/token.js; run: sh scripts/make-token.sh");
