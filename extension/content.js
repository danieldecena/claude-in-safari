// Runs in every page (manifest content_scripts, and tabs.executeScript for tabs that were
// already open). background.js calls window.__cis.run via executeScript, because Safari's
// runtime.onMessage never delivered a reply; refs live in this page's memory.
if (!window.__cis?.run) {

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

  const handlers = { get_page_text: getPageText, read_page: readPage, find };
  window.__cis = {
    run: (method, params) => {
      try {
        return { result: handlers[method](params ?? {}) };
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    },
  };
}
