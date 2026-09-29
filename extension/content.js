// Runs in every page (manifest content_scripts, and tabs.executeScript for tabs that were
// already open). background.js calls window.__cis.run via executeScript, because Safari's
// runtime.onMessage never delivered a reply; refs live in this page's memory.
// The version guard lets an updated extension replace handlers in already-open pages
// (their refs reset, so re-run read_page after an update). No top-level bindings here:
// executeScript re-runs this file in the same isolated world, and a top-level const
// would throw a redeclaration SyntaxError on every call after the first.
if ((window.__cis?.version ?? 0) < 3) {
  const CIS_VERSION = 3;

  // Console capture (manifest injects this file at document_start so early logs are seen).
  // console.* runs in the page world, so a hook is injected there and relayed via postMessage;
  // pages with a strict CSP block the inline hook and only window error events get captured.
  if (!window.__cis_logs) {
    const logs = [];
    window.__cis_logs = logs;
    const push = (level, text) => {
      logs.push({ t: Date.now(), level, text: String(text).slice(0, 2000) });
      if (logs.length > 500) logs.splice(0, logs.length - 500);
    };
    window.addEventListener("message", (ev) => {
      if (ev.source === window && ev.data?.__cis_console) push(ev.data.__cis_console.level, ev.data.__cis_console.text);
    });
    window.addEventListener("error", (ev) => push("error", ev.message + (ev.filename ? ` (${ev.filename}:${ev.lineno})` : "")));
    window.addEventListener("unhandledrejection", (ev) => push("error", `unhandled rejection: ${ev.reason?.message ?? ev.reason}`));
    const hook = document.createElement("script");
    hook.textContent = `(${function () {
      const fmt = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } };
      for (const level of ["log", "info", "warn", "error", "debug"]) {
        const orig = console[level];
        console[level] = function (...args) {
          try { window.postMessage({ __cis_console: { level, text: args.map(fmt).join(" ") } }, "*"); } catch {}
          return orig.apply(this, args);
        };
      }
    }})()`;
    (document.head ?? document.documentElement).appendChild(hook);
    hook.remove();
  }

  const refs = new Map();
  const ids = new WeakMap();
  let nextRef = 1;
  const refFor = (el) => {
    if (!ids.has(el)) {
      const id = `ref_${nextRef++}`;
      ids.set(el, id);
      refs.set(id, new WeakRef(el));
    }
    return ids.get(el);
  };

  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider" };
  const TAG_ROLES = { a: "link", button: "button", select: "combobox", textarea: "textbox", img: "img", nav: "navigation", main: "main", header: "banner", footer: "contentinfo", form: "form", table: "table", ul: "list", ol: "list", li: "listitem" };
  const INTERACTIVE = new Set(["link", "button", "textbox", "checkbox", "radio", "combobox", "slider", "menuitem", "tab", "switch"]);

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return INPUT_ROLES[el.type] ?? "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "a" && !el.hasAttribute("href")) return null;
    return TAG_ROLES[tag] ?? null;
  };

  const nameOf = (el) => {
    const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder");
    if (label) return label.trim();
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/.test(el.type)) return el.value;
    if (el.labels?.[0]) return el.labels[0].innerText.trim();
    return (el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };

  const describe = (el, role) => {
    let line = role;
    const name = nameOf(el);
    if (name) line += ` "${name}"`;
    line += ` [${refFor(el)}]`;
    if (el.href) line += ` href="${el.href}"`;
    if (el.type && el.tagName === "INPUT") line += ` type="${el.type}"`;
    if ("value" in el && el.value && el.tagName !== "BUTTON" && !/^(button|submit|reset)$/.test(el.type)) line += ` value="${String(el.value).slice(0, 60)}"`;
    return line;
  };

  const readPage = ({ filter = "all", maxChars = 50000 } = {}) => {
    const lines = [];
    const walk = (el, depth) => {
      if (!(el instanceof Element) || !visible(el)) return;
      const role = roleOf(el);
      const keep = role && (filter !== "interactive" || INTERACTIVE.has(role));
      if (keep) lines.push(`${"  ".repeat(depth)}${describe(el, role)}`);
      for (const c of el.children) walk(c, keep ? depth + 1 : depth);
    };
    walk(document.body, 0);
    const out = lines.join("\n");
    return out.length > maxChars ? `${out.slice(0, maxChars)}\n[truncated at ${maxChars} chars]` : out;
  };

  const find = ({ query }) => {
    const q = query.toLowerCase();
    const hits = [];
    for (const el of document.querySelectorAll("*")) {
      const role = roleOf(el);
      if (!role || !visible(el)) continue;
      const hay = `${role} ${nameOf(el)} ${el.getAttribute("href") ?? ""}`.toLowerCase();
      if (hay.includes(q)) hits.push(describe(el, role));
      if (hits.length === 20) break;
    }
    return hits;
  };

  const getPageText = () => {
    const root = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
    return { title: document.title, url: location.href, text: root.innerText };
  };

  const deref = (ref) => {
    if (!ref) throw new Error("ref is required; get one from read_page or find");
    const el = refs.get(ref)?.deref();
    if (!el?.isConnected) throw new Error(`${ref} not found or no longer in the page; re-run read_page or find`);
    return el;
  };

  const mouseOpts = (el) => {
    const r = el.getBoundingClientRect();
    return { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  };

  const click = ({ ref }) => {
    const el = deref(ref);
    el.scrollIntoView({ block: "center", inline: "center" });
    const o = mouseOpts(el);
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.focus?.();
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", o));
    return { clicked: describe(el, roleOf(el) ?? "element"), url: location.href };
  };

  const type = ({ ref, text }) => {
    if (text == null) throw new Error("type needs text");
    const el = deref(ref);
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
    } else if ("value" in el) {
      // Frameworks patch .value on the instance; the prototype setter keeps their change tracking intact.
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      set ? set.call(el, text) : (el.value = text);
    } else {
      throw new Error(`${ref} is not an editable element`);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: describe(el, roleOf(el) ?? "element") };
  };

  const keyPress = ({ ref, key }) => {
    if (!key) throw new Error("key needs a key name like Enter, Escape, Tab or ArrowDown");
    const el = ref ? deref(ref) : (document.activeElement ?? document.body);
    const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key) : key;
    const o = { bubbles: true, cancelable: true, key, code };
    const proceed = el.dispatchEvent(new KeyboardEvent("keydown", o));
    el.dispatchEvent(new KeyboardEvent("keyup", o));
    // Synthetic events trigger no browser default action, so Enter submits the enclosing form by hand.
    if (proceed && key === "Enter") el.closest?.("form")?.requestSubmit?.();
    return { key, target: el === document.body ? "body" : describe(el, roleOf(el) ?? "element"), url: location.href };
  };

  const scroll = ({ ref, direction, amount }) => {
    if (ref && !direction) {
      deref(ref).scrollIntoView({ block: "center", inline: "center" });
    } else {
      const d = direction ?? "down";
      const a = amount ?? Math.round((d === "left" || d === "right" ? innerWidth : innerHeight) * 0.8);
      const left = d === "left" ? -a : d === "right" ? a : 0;
      const top = d === "up" ? -a : d === "down" ? a : 0;
      (ref ? deref(ref) : window).scrollBy({ left, top, behavior: "instant" });
    }
    return { scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
  };

  const javascript = ({ code }) => {
    const result = (0, eval)(code);
    try {
      JSON.stringify(result);
      return { result: result === undefined ? "undefined" : result };
    } catch {
      return { result: String(result) };
    }
  };

  const readConsole = ({ clear = false } = {}) => {
    const lines = (window.__cis_logs ?? []).map((l) => `${new Date(l.t).toISOString().slice(11, 23)} [${l.level}] ${l.text}`);
    if (clear) window.__cis_logs?.splice(0);
    return lines;
  };

  const ACTIONS = { click, type, key: keyPress, scroll };
  const computer = (params) => {
    const fn = ACTIONS[params.action];
    if (!fn) throw new Error(`unknown action: ${params.action}`);
    return fn(params);
  };

  const handlers = { get_page_text: getPageText, read_page: readPage, find, computer, javascript, read_console: readConsole };
  window.__cis = {
    version: CIS_VERSION,
    run: (method, params) => {
      try {
        return { result: handlers[method](params ?? {}) };
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    },
  };
}
