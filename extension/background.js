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
    const sock = ev.target;
    let id, method, params;
    try { ({ id, method, params } = JSON.parse(ev.data)); } catch { return; }
    let reply;
    try {
      reply = { id, result: await handle(method, params ?? {}) };
    } catch (e) {
      reply = { id, error: String(e?.message ?? e) };
    }
    // The bridge may have gone while the call ran; send() on a closed socket throws.
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
  };
  ws.onclose = () => {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
}

// Tabs opened before the extension loaded have no content script, so load it first;
// content.js guards against running twice.
// A tab that is still loading (right after navigate) returns nothing from executeScript, so
// retry for a few seconds before giving up. Errors the page's own code raised are not retried.
async function inPage(tabId, method, params, frameId) {
  const code = `window.__cis.run(${JSON.stringify(method)}, ${JSON.stringify(params)})`;
  const deadline = Date.now() + 5000;
  let last = "no result";
  while (Date.now() < deadline) {
    try {
      const at = frameId ? { frameId } : {};
      await chrome.tabs.executeScript(tabId, { file: "content.js", ...at });
      const [r] = await chrome.tabs.executeScript(tabId, { code, ...at });
      if (r?.error) throw Object.assign(new Error(r.error), { fromPage: true });
      if (r) return r.result;
      last = "no result";
    } catch (e) {
      if (e.fromPage) throw e;
      last = String(e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`tab ${tabId} did not accept the script (still loading or not scriptable): ${last}`);
}

// Page tools reach the top frame only; the reading tools also visit each subframe so an app
// living in an iframe (iCloud Mail) is not invisible. Refs are per-frame memory, so subframe
// refs are tagged f<frameId>: and computer routes them back to that frame. A frame that will not take the
// script (sandboxed, still loading) is skipped: the top-frame answer stands on its own.
async function withFrames(tabId, method, params, top) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => [])).filter((f) => f.frameId !== 0);
  const subs = [];
  for (const f of frames) {
    try {
      let r = await inPage(tabId, method, params, f.frameId);
      if (method === "read_page") r = r.replace(/\[(ref_\d+)\]/g, `[f${f.frameId}:$1]`);
      subs.push({ frameId: f.frameId, url: f.url, r });
    } catch {}
  }
  if (method === "get_page_text") {
    const withText = subs.filter((f) => f.r.text?.trim()).map((f) => ({ frameId: f.frameId, url: f.url, text: f.r.text }));
    return withText.length ? { ...top, frames: withText } : top;
  }
  return top + subs.filter((f) => f.r.trim()).map((f) => `\n[frame f${f.frameId} ${f.url}]\n${f.r}`).join("");
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
      // Without this wait, a page tool called right after navigate can read the previous
      // document, which executeScript still accepts while the new one loads.
      let loaded;
      const done = new Promise((r) => (loaded = r));
      let t;
      const onUpdated = (id, change) => { if (id === (params.tabId ?? t?.id) && change.status === "complete") loaded(); };
      chrome.tabs.onUpdated.addListener(onUpdated);
      try {
        t = params.tabId == null
          ? await chrome.tabs.create({ url: params.url, active: false })
          : await chrome.tabs.update(params.tabId, { url: params.url });
        await Promise.race([done, new Promise((r) => setTimeout(r, 10000))]);
      } finally {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
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
      try {
        return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
      } finally {
        if (prev && prev.id !== params.tabId) await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
      }
    }
    case "tab": {
      const { tabId, action } = params;
      if (action === "close") await chrome.tabs.remove(tabId);
      else if (action === "reload") await chrome.tabs.reload(tabId);
      else if (action === "back" || action === "forward") await inPage(tabId, "history", { action });
      else throw new Error(`tab: unknown action ${action}`);
      return { tabId, action };
    }
    case "get_page_text":
    case "read_page":
      return withFrames(params.tabId, method, params, await inPage(params.tabId, method, params));
    case "find": {
      const top = await inPage(params.tabId, "find", params);
      const frames = (await chrome.webNavigation.getAllFrames({ tabId: params.tabId }).catch(() => [])).filter((f) => f.frameId !== 0);
      const hits = [...top];
      for (const f of frames) {
        if (hits.length >= 20) break;
        try {
          const r = await inPage(params.tabId, "find", params, f.frameId);
          hits.push(...r.map((l) => l.replace(/\[(ref_\d+)\]/, `[f${f.frameId}:$1]`)));
        } catch {}
      }
      return hits.slice(0, 20);
    }
    case "computer": {
      // Refs from subframes arrive as f<frameId>:ref_N; the content script in that frame knows
      // only the bare ref_N.
      const m = /^f(\d+):(ref_\d+)$/.exec(params.ref ?? "");
      if (!m) return inPage(params.tabId, method, params);
      const frameId = Number(m[1]);
      const frames = await chrome.webNavigation.getAllFrames({ tabId: params.tabId }).catch(() => []);
      if (!frames.some((f) => f.frameId === frameId)) throw new Error(`${params.ref}: frame ${frameId} no longer exists; re-run read_page or find`);
      return inPage(params.tabId, method, { ...params, ref: m[2] }, frameId);
    }
    case "javascript":
      return inPage(params.tabId, method, params, params.frameId);
    case "read_console":
    case "read_network":
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
