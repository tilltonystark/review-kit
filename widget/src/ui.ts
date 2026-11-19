/**
 * The Review Kit comment UI: a pill to start commenting, a DevTools-style
 * overlay while picking an element, and a panel to write and send.
 *
 * Everything lives in one Shadow DOM, so the site's CSS can't change the
 * widget and the widget's CSS can't touch the site.
 */
import type { WidgetOptions } from "./index";
import { boxModel, describeElement, deviceInfo, elementLabel, shorthand, type Sides } from "./inspect";

type Mode = "idle" | "picking" | "composing" | "sending";
type Status = {
  ready?: boolean;
  problem?: string | null;
  warning?: string | null;
  keyRequired?: boolean;
  keyValid?: boolean;
  reviewer?: string | null;
  screenshots?: boolean;
};
type Sent = { label: string; url: string | null };

const PENDING = "review-kit-pending";
const HOST_TAG = "review-kit-root";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.rk { font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #11243e; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 1; }
.layer div { position: fixed; pointer-events: none; box-sizing: border-box; }
.tag { background: #11243e; color: #fff; font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 4px 8px; border-radius: 6px; max-width: min(92vw, 26rem); box-shadow: 0 4px 14px rgba(0,0,0,.25); }
.tag b { color: #ffd84d; } .tag .p { color: #93c47d; } .tag .m { color: #f6b26b; } .tag .b { color: #ffe599; }
.dock { position: fixed; bottom: 16px; z-index: 2; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; max-width: calc(100vw - 32px); }
.dock.right { right: 16px; align-items: flex-end; } .dock.left { left: 16px; }
.pill { display: flex; align-items: center; gap: 2px; background: #11243e; color: #fff; border-radius: 999px; padding: 4px; box-shadow: 0 6px 24px rgba(17,36,62,.3); }
button { font: inherit; cursor: pointer; border: 0; background: none; color: inherit; border-radius: 999px; padding: 6px 12px; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; }
button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #4f8cff; outline-offset: 2px; }
.pill button:hover { background: rgba(255,255,255,.12); }
.pill .main { font-weight: 600; }
.pill .on { background: #ffd84d; color: #11243e; }
.pill .on:hover { background: #ffe27a; }
.pill .icon { padding: 6px 9px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #f6b26b; display: inline-block; }
.count { background: rgba(255,255,255,.18); border-radius: 999px; padding: 0 7px; font-size: 11px; }
.panel { width: 360px; max-width: calc(100vw - 32px); background: #fff; border: 1px solid #d7dde6; border-radius: 14px; box-shadow: 0 12px 40px rgba(17,36,62,.22); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.head { display: flex; align-items: center; gap: 6px; }
.head .label { flex: 1; min-width: 0; font: 600 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghost { border: 1px solid #d7dde6; padding: 4px 10px; min-height: 28px; font-size: 12px; }
.ghost:hover { background: #f2f5f9; }
dl { display: grid; grid-template-columns: 5.5rem 1fr; gap: 2px 8px; margin: 0; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
dt { color: #5b6b84; } dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea, input { width: 100%; font: inherit; color: #11243e; background: #fff; border: 1px solid #c3ccd8; border-radius: 10px; padding: 8px 10px; }
textarea { min-height: 84px; resize: vertical; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hint { color: #5b6b84; font-size: 11.5px; }
.send { background: #11243e; color: #fff; font-weight: 600; }
.send:hover { background: #1d3a61; }
.send[disabled] { opacity: .5; cursor: default; }
.msg { border-radius: 10px; padding: 8px 10px; font-size: 12.5px; }
.msg.err { background: #fdecec; color: #8a1c1c; } .msg.warn { background: #fff4e0; color: #7a4a00; } .msg.ok { background: #e8f6ec; color: #145c2b; }
.msg a { color: inherit; font-weight: 600; }
.sent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.sent a { color: #1d4ed8; }
.hidden { display: none !important; }
@media (max-width: 640px) {
  .dock { left: 8px !important; right: 8px !important; bottom: 8px; align-items: stretch !important; }
  .pill { align-self: flex-start; }
  .dock.right .pill { align-self: flex-end; }
  .panel { width: auto; max-width: none; max-height: 70vh; overflow: auto; border-radius: 16px 16px 12px 12px; }
  dl { display: none; }
  button { min-height: 40px; }
}
@media (prefers-reduced-motion: no-preference) { .panel { animation: rk-in .16s ease-out; } }
@keyframes rk-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
}

function pending(action: "get" | "set" | "del", value?: unknown): { comment: string; page: string; label: string } | null {
  try {
    if (action === "get") return JSON.parse(localStorage.getItem(PENDING) ?? "null");
    if (action === "set") localStorage.setItem(PENDING, JSON.stringify(value));
    else localStorage.removeItem(PENDING);
  } catch {
    /* storage blocked */
  }
  return null;
}

export function mount(opts: WidgetOptions) {
  if (document.querySelector(HOST_TAG)) return;
  const host = document.createElement(HOST_TAG);
  host.setAttribute("data-review-kit", "");
  host.style.cssText = "position:fixed;inset:auto;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  document.documentElement.append(host);

  let mode: Mode = "idle";
  let hovered: Element | null = null;
  let selected: Element | null = null;
  let key = opts.key;
  let status: Status = {};
  let error: string | null = null;
  let notice: { text: string; url?: string | null } | null = null;
  let askKey = false;
  const sent: Sent[] = [];

  /* ---------- DOM ---------- */
  const style = h("style");
  style.textContent = CSS;
  const wrap = h("div", { class: "rk" });
  const layer = h("div", { class: "layer", "aria-hidden": "true" });
  const dock = h("div", { class: `dock ${opts.position}` });

  const mainBtn = h("button", { class: "main", type: "button", title: "Comment on any element (C)" });
  const countEl = h("span", { class: "count hidden" });
  const warnDot = h("span", { class: "dot hidden", title: "Review Kit needs attention" });
  const offBtn = h("button", { class: "icon", type: "button", title: "Hide Review Kit", "aria-label": "Hide Review Kit", text: "✕" });
  const pill = h("div", { class: "pill", role: "toolbar", "aria-label": "Review Kit" }, mainBtn, warnDot, countEl, offBtn);

  const panel = h("div", { class: "panel hidden", role: "dialog", "aria-label": "Write a review comment" });
  const labelEl = h("span", { class: "label" });
  const parentBtn = h("button", { class: "ghost", type: "button", title: "Select the surrounding block", text: "Parent" });
  const closeBtn = h("button", { class: "ghost", type: "button", "aria-label": "Cancel", text: "Cancel" });
  const inspector = h("dl");
  const textarea = h("textarea", { placeholder: "What should change here?", "aria-label": "Your comment", maxlength: "4000" });
  const keyInput = h("input", { type: "password", placeholder: "Review key", "aria-label": "Review key", autocomplete: "off" });
  const honeypot = h("input", { type: "text", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", class: "hidden", name: "website" });
  const errorEl = h("div", { class: "msg err hidden", role: "alert" });
  const sendBtn = h("button", { class: "send", type: "button", text: "Send to GitHub" });
  const hint = h("span", { class: "hint", text: navigator.platform.includes("Mac") ? "⌘ + Enter" : "Ctrl + Enter" });
  panel.append(
    h("div", { class: "head" }, labelEl, parentBtn, closeBtn),
    inspector,
    textarea,
    keyInput,
    honeypot,
    errorEl,
    h("div", { class: "row" }, hint, sendBtn),
  );

  const noticeEl = h("div", { class: "msg hidden", role: "status" });
  const sentList = h("ul", { class: "sent hidden" });
  dock.append(panel, noticeEl, sentList, pill);
  wrap.append(layer, dock);
  root.append(style, wrap);

  /* ---------- helpers ---------- */
  const isOwn = (node: EventTarget | null) => node === host || (node instanceof Node && host.contains(node));
  const isTooling = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    return el === host || tag.startsWith("vercel-") || tag === "nextjs-portal" || tag === "netlify-drawer" || !!el.closest("vercel-live-feedback, [data-vercel-toolbar]");
  };
  const elementAt = (x: number, y: number): Element | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === document.documentElement || el === document.body) return null;
      if (!isTooling(el)) return el;
    }
    return null;
  };

  /* ---------- overlay ---------- */
  function drawBox(el: Element, strong: boolean) {
    if (!el.isConnected) return;
    const rect = el.getBoundingClientRect();
    const box = boxModel(el);
    const m: Sides = {
      top: Math.max(0, box.margin.top),
      right: Math.max(0, box.margin.right),
      bottom: Math.max(0, box.margin.bottom),
      left: Math.max(0, box.margin.left),
    };
    const px = (s: Sides) => `${s.top}px ${s.right}px ${s.bottom}px ${s.left}px`;
    const outer = h("div");
    outer.style.cssText = `left:${rect.left - m.left}px;top:${rect.top - m.top}px;width:${rect.width + m.left + m.right}px;height:${rect.height + m.top + m.bottom}px;border-style:solid;border-width:${px(m)};border-color:rgba(246,178,107,.55);`;
    const border = h("div");
    border.style.cssText = `position:relative;width:100%;height:100%;border-style:solid;border-width:${px(box.border)};border-color:rgba(255,229,153,.75);`;
    const pad = h("div");
    pad.style.cssText = `position:relative;width:100%;height:100%;border-style:solid;border-width:${px(box.padding)};border-color:rgba(147,196,125,.55);background:rgba(111,168,220,.4);`;
    border.append(pad);
    outer.append(border);
    const line = h("div");
    line.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline:${strong ? "2px solid #e5484d" : "1px solid rgba(17,36,62,.7)"};`;
    const tag = h("div", { class: "tag" });
    const above = rect.top - m.top > 64;
    tag.style.cssText = `left:${Math.min(Math.max(4, rect.left), window.innerWidth - 220)}px;top:${above ? rect.top - m.top - 48 : Math.min(rect.bottom + m.bottom + 6, window.innerHeight - 56)}px;`;
    const name = elementLabel(el).split(" · ")[0];
    tag.innerHTML = `<b></b> ${box.width} × ${box.height}<br><span class="p">padding</span> ${shorthand(box.padding)} <span class="m">margin</span> ${shorthand(box.margin)}${box.border.top || box.border.left ? ` <span class="b">border</span> ${shorthand(box.border)}` : ""}`;
    (tag.querySelector("b") as HTMLElement).textContent = name;
    layer.append(outer, line, tag);
  }

  let frame = 0;
  function drawOverlay() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      layer.replaceChildren();
      const el = mode === "picking" ? hovered : selected;
      if (el && mode !== "idle") drawBox(el, mode !== "picking");
    });
  }

  function drawInspector(el: Element) {
    const info = describeElement(el);
    const rows: [string, string][] = [
      ["Size", `${info.box.width} × ${info.box.height}`],
      ["Padding", shorthand(info.box.padding)],
      ["Margin", shorthand(info.box.margin)],
    ];
    const s = info.styles;
    if (s["font-size"]) rows.push(["Font", [s["font-family"], s["font-size"], s["font-weight"]].filter(Boolean).join(" ")]);
    if (s.color) rows.push(["Color", s.color]);
    if (s["background-color"]) rows.push(["Background", s["background-color"]]);
    inspector.replaceChildren(...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v, title: v })]));
    labelEl.textContent = info.label;
    labelEl.title = info.selector;
  }

  /* ---------- render ---------- */
  function render() {
    const active = mode !== "idle";
    mainBtn.textContent = mode === "picking" ? "Click an element…" : "Comment";
    mainBtn.className = `main${active ? " on" : ""}`;
    mainBtn.setAttribute("aria-pressed", String(active));
    panel.classList.toggle("hidden", !(mode === "composing" || mode === "sending"));
    const showKey = askKey || (status.keyRequired === true && status.keyValid === false);
    keyInput.classList.toggle("hidden", !showKey);
    const setupError = status.ready === false && !showKey ? status.problem : null;
    const err = error ?? setupError ?? null;
    errorEl.textContent = err ?? "";
    errorEl.classList.toggle("hidden", !err);
    warnDot.classList.toggle("hidden", !(status.ready === false || status.warning));
    warnDot.title = status.problem || status.warning || "";
    sendBtn.disabled = mode === "sending" || !textarea.value.trim();
    sendBtn.textContent = mode === "sending" ? "Sending…" : "Send to GitHub";
    countEl.textContent = String(sent.length);
    countEl.classList.toggle("hidden", sent.length === 0);

    noticeEl.classList.toggle("hidden", !notice);
    if (notice) {
      noticeEl.className = `msg ${notice.url === undefined ? "warn" : "ok"}`;
      noticeEl.replaceChildren(notice.text);
      if (notice.url) noticeEl.append(" ", h("a", { href: notice.url, target: "_blank", rel: "noopener", text: "View on GitHub" }));
    }
    document.documentElement.style.cursor = mode === "picking" ? "crosshair" : "";
    drawOverlay();
  }

  function setMode(next: Mode) {
    mode = next;
    if (next === "idle") {
      hovered = null;
      selected = null;
    }
    render();
  }

  /* ---------- picking ---------- */
  const onMove = (e: PointerEvent) => {
    if (mode !== "picking" || isOwn(e.target)) return;
    const el = elementAt(e.clientX, e.clientY);
    if (el !== hovered) {
      hovered = el;
      drawOverlay();
    }
  };
  const swallow = (e: Event) => {
    if (mode !== "picking" || isOwn(e.target) || e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e: MouseEvent) => {
    if (mode !== "picking" || e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = elementAt(e.clientX, e.clientY);
    if (!el) return;
    select(el);
  };
  function select(el: Element) {
    selected = el;
    error = null;
    notice = null;
    drawInspector(el);
    setMode("composing");
    setTimeout(() => textarea.focus({ preventScroll: true }), 0);
  }

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("click", onClick, true);
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "submit"]) window.addEventListener(type, swallow, true);
  const redraw = () => mode !== "idle" && drawOverlay();
  window.addEventListener("scroll", redraw, true);
  window.addEventListener("resize", redraw);

  window.addEventListener("keydown", (e) => {
    const typing = e.composedPath().some((n) => n instanceof HTMLElement && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)));
    if (e.key === "Escape" && mode !== "idle" && mode !== "sending") {
      e.preventDefault();
      setMode("idle");
    } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c" && mode === "idle") {
      e.preventDefault();
      setMode("picking");
    }
  });

  /* ---------- buttons ---------- */
  mainBtn.addEventListener("click", () => {
    notice = null;
    setMode(mode === "idle" ? "picking" : "idle");
  });
  closeBtn.addEventListener("click", () => setMode("idle"));
  parentBtn.addEventListener("click", () => {
    const parent = selected?.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) select(parent);
  });
  offBtn.addEventListener("click", () => {
    opts.turnOff();
    cleanup();
  });
  textarea.addEventListener("input", () => {
    sendBtn.disabled = mode === "sending" || !textarea.value.trim();
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener("click", () => void send());

  function cleanup() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("click", onClick, true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "submit"]) window.removeEventListener(type, swallow, true);
    window.removeEventListener("scroll", redraw, true);
    window.removeEventListener("resize", redraw);
    document.documentElement.style.cursor = "";
    host.remove();
  }

  /* ---------- network ---------- */
  const headers = (): Record<string, string> => ({ "Content-Type": "application/json", ...(key ? { "X-Review-Key": key } : {}) });

  async function check() {
    try {
      const res = await fetch(opts.endpoint, { headers: headers(), cache: "no-store", credentials: "same-origin" });
      if (res.status === 404) {
        status = { ready: false, problem: "Review Kit's server part is missing or switched off on this site." };
      } else {
        status = (await res.json()) as Status;
      }
    } catch {
      status = { ready: false, problem: "Can't reach the Review Kit server for this site." };
    }
    if (status.warning && !notice) notice = { text: status.warning };
    render();
  }

  async function send() {
    if (!selected || mode === "sending") return;
    const comment = textarea.value.trim();
    if (!comment) return;
    if (!keyInput.classList.contains("hidden")) {
      const typed = keyInput.value.trim();
      if (!typed) {
        error = "Enter your review key.";
        render();
        keyInput.focus();
        return;
      }
      key = typed;
      opts.saveKey(typed);
    }
    error = null;
    setMode("sending");
    const target = selected;
    let screenshot: string | null = null;
    if (opts.screenshots && status.screenshots !== false) {
      const { captureViewport } = await import("./screenshot");
      layer.replaceChildren();
      screenshot = await captureViewport(target, host);
    }
    const label = elementLabel(target);
    const page = location.pathname + location.search;
    const body = {
      comment,
      page: { url: location.href, path: page, title: document.title },
      element: describeElement(target),
      device: deviceInfo(),
      screenshot,
      capturedAt: new Date().toISOString(),
      website: honeypot.value,
    };
    try {
      const res = await fetch(opts.endpoint, { method: "POST", headers: headers(), body: JSON.stringify(body), credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as { url?: string | null; error?: string; code?: string; target?: string };
      if (!res.ok) {
        if (res.status === 401) {
          askKey = true;
          key = null;
          opts.saveKey(null);
        }
        if (res.status >= 500 || res.status === 0) pending("set", { comment, page, label });
        throw new Error(data.error ?? `Something went wrong (${res.status}).`);
      }
      pending("del");
      askKey = false;
      sent.push({ label, url: data.url ?? null });
      textarea.value = "";
      notice = { text: data.target === "issue" ? "Sent to the review issue." : "Sent to the pull request.", url: data.url ?? null };
      setMode("idle");
      setTimeout(() => {
        if (notice?.url === (data.url ?? null)) {
          notice = null;
          render();
        }
      }, 8000);
    } catch (e) {
      error = e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Couldn't reach the server. Your text is kept here; try again.";
      mode = "composing";
      render();
    }
  }

  // An unsent comment from last time: offer it again.
  const left = pending("get");
  if (left?.comment) {
    textarea.value = left.comment;
    notice = { text: `You have an unsent comment on ${left.page}. Pick the element again to resend it.` };
  }

  render();
  void check();
}
