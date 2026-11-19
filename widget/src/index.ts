/**
 * Review Kit loader. Tiny on purpose: it decides whether this visitor is a
 * reviewer, and only then loads the comment UI.
 *
 *   <script type="module" src="/review-kit/review-kit.js"
 *           data-endpoint="/api/review-kit"
 *           data-require-key="true"></script>
 *
 * data-endpoint     Where comments are sent. Default /api/review-kit.
 * data-require-key  "true" on a live site: the widget stays hidden until the
 *                   reviewer opens a review link (?review-key=...). Default "false".
 * data-screenshots  "false" to never send screenshots.
 * data-position     "left" (default) or "right".
 */

const KEY = "review-kit-key";
const OFF = "review-kit-off";

function store(action: "get" | "set" | "del", key: string, value?: string): string | null {
  try {
    if (action === "get") return localStorage.getItem(key);
    if (action === "set") localStorage.setItem(key, value ?? "");
    else localStorage.removeItem(key);
  } catch {
    /* private mode or blocked storage */
  }
  return null;
}

export type WidgetOptions = {
  endpoint: string;
  requireKey: boolean;
  screenshots: boolean;
  position: "left" | "right";
  key: string | null;
  saveKey: (key: string | null) => void;
  turnOff: () => void;
};

function boot() {
  if ((window as unknown as { __reviewKit?: boolean }).__reviewKit) return;
  (window as unknown as { __reviewKit?: boolean }).__reviewKit = true;

  const script = (document.currentScript ?? document.querySelector("script[src*='review-kit']")) as HTMLScriptElement | null;
  const data = script?.dataset ?? {};
  const requireKey = data.requireKey === "true";

  // A review link: remember the key, then remove it from the address bar so it
  // is not shared by accident or kept in analytics.
  const url = new URL(location.href);
  const fromLink = url.searchParams.get("review-key");
  if (fromLink !== null) {
    url.searchParams.delete("review-key");
    history.replaceState(history.state, "", url.toString());
    if (fromLink === "off") {
      store("del", KEY);
      store("set", OFF, "1");
      return;
    }
    if (fromLink !== "on") store("set", KEY, fromLink.trim());
    store("del", OFF);
  }

  const key = store("get", KEY);
  if (store("get", OFF) === "1") return;
  if (requireKey && !key) return; // A visitor, not a reviewer: load nothing more.

  const options: WidgetOptions = {
    endpoint: data.endpoint || "/api/review-kit",
    requireKey,
    screenshots: data.screenshots !== "false",
    position: data.position === "right" ? "right" : "left",
    key,
    saveKey: (k) => (k ? store("set", KEY, k) : store("del", KEY)),
    turnOff: () => {
      store("del", KEY);
      if (!requireKey) store("set", OFF, "1");
    },
  };

  const start = () => import("./ui").then((m) => m.mount(options));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else void start();
}

boot();
