// Connects out to the bridge (bridge/server.js). The bridge owns the socket because a
// Safari service worker cannot listen; it can only dial.
const PORT = 18765;
// Shared secret: any Safari extension has a safari-web-extension:// origin, so origin alone
// doesn't identify this one. The bridge parses this constant out of this file at startup;
// rotate it here and rebuild the app (both sides then agree again).
const CIS_TOKEN = "d11d671f3903c626b5d99491d9693399";

const startedAt = Date.now();

let ws;
let backoff = 1000;

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${CIS_TOKEN}`);
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

// Tabs opened before the extension loaded have no content script, so load it first;
// content.js guards against running twice.
async function inPage(tabId, method, params) {
  await chrome.tabs.executeScript(tabId, { file: "content.js" });
  const [r] = await chrome.tabs.executeScript(tabId, { code: `window.__cis.run(${JSON.stringify(method)}, ${JSON.stringify(params)})` });
  if (!r) throw new Error(`no result from tab ${tabId}`);
  if (r.error) throw new Error(r.error);
  return r.result;
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
    case "screenshot": {
      // captureVisibleTab only sees the active tab, so background tabs get activated
      // briefly (with a beat to render) and the previous active tab is put back after.
      const tab = await chrome.tabs.get(params.tabId);
      const [prev] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      if (!tab.active) {
        await chrome.tabs.update(params.tabId, { active: true });
        await new Promise((r) => setTimeout(r, 350));
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      if (prev && prev.id !== params.tabId) await chrome.tabs.update(prev.id, { active: true });
      return { dataUrl };
    }
    case "get_page_text":
    case "read_page":
    case "find":
    case "computer":
    case "javascript":
    case "read_console":
      return inPage(params.tabId, method, params);
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// Safari doesn't reliably run the manifest content script at load (per-site permission
// gating), so inject at commit time through executeScript, which does work; the version
// guard in content.js makes double injection a no-op. Console capture depends on this.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  chrome.tabs.executeScript(tabId, { file: "content.js" }).catch(() => {});
});

// Wakes a suspended worker so it can redial; the S1 spike measures whether this is enough.
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
