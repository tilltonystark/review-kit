/**
 * Reads everything a reviewer (or Claude) needs to find and fix an element:
 * a stable selector, where it sits on the page, its box model and the styles
 * that usually come up in design review. Browser only.
 */

export type Sides = { top: number; right: number; bottom: number; left: number };

export type BoxModel = {
  width: number;
  height: number;
  margin: Sides;
  border: Sides;
  padding: Sides;
  /** Content box, after padding and border. */
  content: { width: number; height: number };
};

export type ElementContext = {
  selector: string;
  tag: string;
  label: string;
  text: string;
  html: string;
  section: string;
  path: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number; pageY: number };
  box: BoxModel;
  styles: Record<string, string>;
};

const round = (n: number) => Math.round(n * 10) / 10;

function sides(style: CSSStyleDeclaration, prop: "margin" | "padding" | "border"): Sides {
  const key = (side: string) => (prop === "border" ? `border-${side}-width` : `${prop}-${side}`);
  return {
    top: round(parseFloat(style.getPropertyValue(key("top"))) || 0),
    right: round(parseFloat(style.getPropertyValue(key("right"))) || 0),
    bottom: round(parseFloat(style.getPropertyValue(key("bottom"))) || 0),
    left: round(parseFloat(style.getPropertyValue(key("left"))) || 0),
  };
}

export function boxModel(el: Element): BoxModel {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const margin = sides(style, "margin");
  const border = sides(style, "border");
  const padding = sides(style, "padding");
  return {
    width: round(rect.width),
    height: round(rect.height),
    margin,
    border,
    padding,
    content: {
      width: round(Math.max(0, rect.width - padding.left - padding.right - border.left - border.right)),
      height: round(Math.max(0, rect.height - padding.top - padding.bottom - border.top - border.bottom)),
    },
  };
}

/** "8 16" style shorthand, like DevTools. */
export function shorthand(s: Sides): string {
  const { top, right, bottom, left } = s;
  if (top === right && right === bottom && bottom === left) return `${top}`;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return `${top} ${right} ${bottom} ${left}`;
}

function segment(node: Element): string {
  const tag = node.tagName.toLowerCase();
  const parent = node.parentElement;
  if (!parent) return tag;
  const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
  return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag;
}

/** Shortest-ish selector that is unique on the page, anchored on the nearest id. */
export function cssSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(" > ");
    }
    parts.unshift(segment(node));
    node = node.parentElement;
  }
  return ["body", ...parts].join(" > ");
}

/** Readable trail such as main > section#pricing > article > h3. */
function readablePath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    parts.unshift(node.id ? `${tag}#${node.id}` : tag);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

const clean = (s: string | null | undefined, max = 280) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Short name for the element: its text, alt, aria-label or tag. */
export function elementLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const name =
    el.getAttribute("aria-label") ||
    el.getAttribute("alt") ||
    clean((el as HTMLElement).innerText, 60) ||
    el.getAttribute("title") ||
    "";
  return name ? `${tag} · ${clean(name, 60)}` : tag;
}

/** The landmark the element lives in, named by its id, label or heading. */
function sectionName(el: Element): string {
  const landmark = el.closest("section, article, header, footer, nav, aside, form, main, dialog");
  if (!landmark) return "";
  const heading = landmark.querySelector("h1, h2, h3");
  const name =
    landmark.getAttribute("aria-label") ||
    clean(heading?.textContent, 80) ||
    landmark.id ||
    "";
  const tag = landmark.tagName.toLowerCase();
  return [landmark.id ? `${tag}#${landmark.id}` : tag, name && `"${name}"`].filter(Boolean).join(" ");
}

let ctx2d: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour (oklch, lab…) as #rrggbb, with alpha as a percentage when not opaque. */
function toHex(color: string): string | null {
  if (ctx2d === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!ctx2d || !color) return null;
  ctx2d.clearRect(0, 0, 1, 1);
  ctx2d.fillStyle = "#000";
  ctx2d.fillStyle = color;
  ctx2d.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx2d.getImageData(0, 0, 1, 1).data;
  if (a === 0) return null;
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  return a < 255 ? `${hex} ${Math.round((a / 255) * 100)}%` : hex;
}

/** A colour as hex, plus the original when it is something else (oklch, var). */
export function describeColor(color: string): string {
  const hex = toHex(color);
  if (!hex) return color;
  return color.startsWith("#") || color.startsWith("rgb") ? hex : `${hex} (${color})`;
}

const STYLE_KEYS = [
  "display",
  "position",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "border-radius",
  "gap",
  "text-align",
] as const;

const ATTRIBUTE_KEYS = ["href", "src", "alt", "aria-label", "role", "type", "name", "class"] as const;

export function describeElement(el: Element): ElementContext {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const key of STYLE_KEYS) {
    const value = style.getPropertyValue(key);
    if (value && value !== "normal" && value !== "none" && value !== "rgba(0, 0, 0, 0)") styles[key] = value;
  }
  for (const key of ["color", "background-color"]) {
    if (styles[key]) styles[key] = describeColor(styles[key]);
  }
  if (styles.position === "static") delete styles.position;
  if (styles["border-radius"] === "0px") delete styles["border-radius"];
  if (styles["font-family"]) styles["font-family"] = styles["font-family"].split(",")[0].replace(/["']/g, "");

  const attributes: Record<string, string> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const value = el.getAttribute(key);
    if (value) attributes[key] = value.slice(0, 300);
  }

  // Frameworks leave empty <!-- --> markers between text nodes; drop them.
  const html = el.outerHTML.replace(/<!-- -->/g, "");
  return {
    selector: cssSelector(el),
    tag: el.tagName.toLowerCase(),
    label: elementLabel(el),
    text: clean((el as HTMLElement).innerText ?? el.textContent),
    html: html.length > 2000 ? `${html.slice(0, 2000)}\n<!-- …truncated, ${html.length} chars total -->` : html,
    section: sectionName(el),
    path: readablePath(el),
    attributes,
    rect: {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
      pageY: round(rect.y + window.scrollY),
    },
    box: boxModel(el),
    styles,
  };
}

export function deviceInfo() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Other";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : "Other";
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio,
    scrollY: Math.round(window.scrollY),
    browser,
    os,
    touch: matchMedia("(pointer: coarse)").matches,
    userAgent: ua,
  };
}
