// Connects out to the bridge (bridge/server.js). The bridge owns the socket because a
// Safari service worker cannot listen; it can only dial.
const PORT = 18765;

const startedAt = Date.now();

let ws;
let backoff = 1000;

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onopen = () => {
    backoff = 1000;
    ws.send(JSON.stringify({ type: "hello", startedAt, ua: navigator.userAgent }));
  };
  ws.onmessage = async (ev) => {
    const { id, method, params } = JSON.parse(ev.data);
    try {
      ws.send(JSON.stringify({ id, result: await handle(method, params) }));
    } catch (e) {
      ws.send(JSON.stringify({ id, error: String(e?.message ?? e) }));
    }
  };
  ws.onclose = () => {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
}

async function handle(method, params) {
  switch (method) {
    case "ping":
      // uptimeMs resetting between pings means Safari killed and restarted the worker.
      return { pong: true, startedAt, uptimeMs: Date.now() - startedAt };
    case "tabs_context": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active }));
    }
    case "navigate": {
      if (!/^https?:\/\//.test(params.url)) throw new Error("navigate: url must start with http:// or https://");
      const t = params.tabId == null
        ? await chrome.tabs.create({ url: params.url, active: false })
        : await chrome.tabs.update(params.tabId, { url: params.url });
      return { tabId: t.id, windowId: t.windowId };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// Wakes a suspended worker so it can redial; the S1 spike measures whether this is enough.
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
