const $ = (id) => document.getElementById(id);

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function upFor(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

function cell(className, text) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  if (className === "title") el.title = text;
  return el;
}

async function refresh() {
  const bg = await browser.runtime.getBackgroundPage();
  const s = bg.popupStatus();
  $("dot").className = s.connected ? "on" : "off";
  $("label").textContent = s.connected ? "Connected to bridge" : "Waiting for bridge";

  if (s.connected) {
    const parts = [s.browser];
    if (s.bridge) {
      parts.push(`${s.bridge.sessions} Claude session${s.bridge.sessions === 1 ? "" : "s"}`);
      parts.push(`bridge up ${upFor(s.bridge.bootedAt)}`);
    } else {
      parts.push(`connected ${ago(s.connectedAt)}`);
    }
    $("summary").textContent = parts.join(" · ");
  } else {
    $("summary").textContent = `Nothing listening on port ${s.port}. Start a Claude Code session with the claude-in-safari MCP.`;
  }
  $("reconnect").hidden = s.connected;

  const list = $("recent");
  list.replaceChildren();
  $("recentSection").hidden = !s.connected && !s.recent.length;
  if (!s.recent.length) {
    list.append(cell("empty", "No commands yet"));
  } else {
    for (const e of s.recent) {
      list.append(
        cell("method", e.method),
        cell("title", e.title ?? (e.tabId == null ? "(new tab)" : `tab ${e.tabId}`)),
        cell("when", ago(e.at)),
      );
    }
  }

  $("version").textContent = `Claude in Safari ${browser.runtime.getManifest().version}`;
  $("content").textContent = s.contentVersion ? `content.js v${s.contentVersion}` : "";
}

$("reconnect").addEventListener("click", async () => {
  (await browser.runtime.getBackgroundPage()).popupReconnect();
  $("label").textContent = "Reconnecting...";
  setTimeout(refresh, 800);
});

refresh().catch((e) => ($("label").textContent = "Error: " + (e?.message ?? e)));
setInterval(() => refresh().catch(() => {}), 1000);
