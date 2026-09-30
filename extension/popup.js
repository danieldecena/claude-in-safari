const dot = document.getElementById("dot");
const label = document.getElementById("label");
const detail = document.getElementById("detail");

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function refresh() {
  const bg = await browser.runtime.getBackgroundPage();
  const s = bg.popupStatus();
  dot.className = s.connected ? "on" : "off";
  label.textContent = s.connected ? "Connected to bridge" : "Waiting for bridge";
  const lines = [];
  if (s.connected) lines.push(`Since ${ago(s.connectedAt)}`);
  else lines.push(`Nothing listening on port ${s.port}. Start a Claude Code session with the claude-in-safari MCP.`);
  if (s.lastCommand) lines.push(`Last command: ${s.lastCommand.method}, ${ago(s.lastCommand.at)}`);
  detail.textContent = lines.join("\n");
  detail.style.whiteSpace = "pre-line";
}

document.getElementById("reconnect").addEventListener("click", async () => {
  (await browser.runtime.getBackgroundPage()).popupReconnect();
  label.textContent = "Reconnecting...";
  setTimeout(refresh, 800);
});

refresh().catch((e) => (label.textContent = "Error: " + (e?.message ?? e)));
setInterval(() => refresh().catch(() => {}), 1000);
