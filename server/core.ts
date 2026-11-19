/**
 * Review Kit server handler.
 *
 * One function that turns a review comment from the browser widget into a
 * GitHub comment. It is written against the standard web Request/Response, so
 * the same code runs in Next.js, Vercel/Netlify functions, Cloudflare Workers,
 * Deno, Bun and Node (through the node adapter).
 *
 *   GET  -> setup check (never shows the token)
 *   POST -> post a comment
 *   OPTIONS -> CORS preflight, only when `allowedOrigins` is set (relay mode)
 *
 * Where a comment goes:
 *   1. the open pull request for this deployment's branch, or
 *   2. an issue titled "Site review: <branch>" (labelled `review-kit`), created
 *      on first use, when the branch has no open PR (production, staging...).
 *
 * The GitHub token only ever lives here, on the server.
 */

export type Environment = "production" | "preview" | "development";

export type ReviewKitConfig = {
  /** Fine-grained GitHub token: Issues, Pull requests, Contents (read and write) on one repo. */
  token?: string;
  /** "owner/name" of the repo that receives comments. */
  repo?: string;
  /** Branch this deployment was built from. */
  branch?: string;
  /** Commit this deployment was built from. */
  commit?: string;
  /** Open PR number for this deployment, when the host knows it. */
  pullRequest?: number;
  /** Where this deployment runs. Production needs a reviewer key by default. */
  environment?: Environment;
  /** Shown in each comment, e.g. the deployment URL. */
  deploymentUrl?: string;
  /**
   * Reviewer keys: { "Om": "k_8f...", "Satyam": "k_2c..." }. When set, every
   * comment needs one of these keys and is signed with the reviewer's name.
   */
  reviewers?: Record<string, string>;
  /**
   * Off production: require a reviewer key? Default: yes when `reviewers` is
   * set. Production always requires one, whatever this says.
   */
  requireKey?: boolean;
  /** Turn the whole thing off without removing code. */
  disabled?: boolean;
  /**
   * Sites allowed to call this endpoint from another origin (relay mode),
   * e.g. ["https://example.com"]. Leave empty for same-origin use.
   */
  allowedOrigins?: string[];
  /** Comments per reviewer (or per IP without keys) per hour. Default 20. */
  rateLimitPerHour?: number;
  /** Store screenshots on a branch of the repo. Default true. */
  screenshots?: boolean;
  /** Branch that holds screenshots. Default "review-assets". */
  assetsBranch?: string;
  /** Label put on "Site review" issues. Default "review-kit". */
  issueLabel?: string;
  /** For tests and GitHub Enterprise. Default https://api.github.com. */
  githubApiUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
};

export const VERSION = "0.1.0";
const MAX_COMMENT = 4000;
const MAX_SCREENSHOT = 3_000_000; // characters of base64, about 2.2 MB
const MAX_BODY = 4_000_000;

/* ------------------------------------------------------------------ config */

/** Removes the usual paste slips: spaces, quotes, a leading "Bearer ". */
export function cleanToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const token = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^(bearer|token)\s+/i, "")
    .trim();
  return token || undefined;
}

/** "Om:k_8f..., Satyam:k_2c..." -> { Om: "k_8f...", Satyam: "k_2c..." } */
export function parseReviewers(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(/[,\n]/)) {
    const i = part.lastIndexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const key = part.slice(i + 1).trim();
    if (name && key.length >= 8) out[name] = key;
  }
  return Object.keys(out).length ? out : undefined;
}

function repoFromUrl(url: string | undefined): string | undefined {
  const m = url && /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Reads the config from environment variables, understanding the variables
 * that Vercel, Netlify, Cloudflare Pages, Render and GitHub Actions set.
 * REVIEW_KIT_* variables always win.
 */
export function configFromEnv(env: Record<string, string | undefined>): ReviewKitConfig {
  const e = (k: string) => env[k]?.trim() || undefined;

  const repo =
    e("REVIEW_KIT_REPO") ||
    (e("VERCEL_GIT_REPO_OWNER") && e("VERCEL_GIT_REPO_SLUG")
      ? `${e("VERCEL_GIT_REPO_OWNER")}/${e("VERCEL_GIT_REPO_SLUG")}`
      : undefined) ||
    repoFromUrl(e("REPOSITORY_URL")) || // Netlify
    repoFromUrl(e("RENDER_GIT_REPO_SLUG") ? `github.com/${e("RENDER_GIT_REPO_SLUG")}` : undefined) ||
    e("GITHUB_REPOSITORY");

  const branch =
    e("REVIEW_KIT_BRANCH") ||
    e("VERCEL_GIT_COMMIT_REF") ||
    e("HEAD") || // Netlify
    e("CF_PAGES_BRANCH") ||
    e("RENDER_GIT_BRANCH") ||
    e("GITHUB_REF_NAME");

  const commit =
    e("REVIEW_KIT_COMMIT") || e("VERCEL_GIT_COMMIT_SHA") || e("COMMIT_REF") || e("CF_PAGES_COMMIT_SHA") || e("RENDER_GIT_COMMIT");

  let environment: Environment | undefined;
  const forced = e("REVIEW_KIT_ENV");
  if (forced === "production" || forced === "preview" || forced === "development") environment = forced;
  else if (e("VERCEL_ENV")) environment = e("VERCEL_ENV") === "production" ? "production" : e("VERCEL_ENV") === "preview" ? "preview" : "development";
  else if (e("CONTEXT")) environment = e("CONTEXT") === "production" ? "production" : e("CONTEXT") === "dev" ? "development" : "preview"; // Netlify
  else if (e("CF_PAGES")) environment = branch && branch === (e("REVIEW_KIT_PRODUCTION_BRANCH") ?? "main") ? "production" : "preview";
  else if (e("NODE_ENV") === "development") environment = "development";
  // Unknown host: assume production, the safe choice (keys required).
  environment ??= "production";

  const pr = Number(e("REVIEW_KIT_PR") || e("VERCEL_GIT_PULL_REQUEST_ID") || e("REVIEW_ID")); // REVIEW_ID = Netlify deploy preview
  const deploymentUrl = e("REVIEW_KIT_DEPLOYMENT_URL") || (e("VERCEL_URL") ? `https://${e("VERCEL_URL")}` : undefined) || e("DEPLOY_PRIME_URL") || e("CF_PAGES_URL") || e("RENDER_EXTERNAL_URL");
  const origins = e("REVIEW_KIT_ALLOWED_ORIGINS");

  return {
    token: cleanToken(e("REVIEW_KIT_GITHUB_TOKEN") || e("GITHUB_REVIEW_TOKEN")),
    repo,
    branch,
    commit,
    pullRequest: Number.isFinite(pr) && pr > 0 ? pr : undefined,
    environment,
    deploymentUrl,
    reviewers: parseReviewers(e("REVIEW_KIT_REVIEWERS")),
    requireKey: e("REVIEW_KIT_REQUIRE_KEY") ? e("REVIEW_KIT_REQUIRE_KEY") === "1" || e("REVIEW_KIT_REQUIRE_KEY") === "true" : undefined,
    disabled: e("REVIEW_KIT_DISABLED") === "1" || e("REVIEW_KIT_DISABLED") === "true",
    allowedOrigins: origins ? origins.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean) : undefined,
    rateLimitPerHour: Number(e("REVIEW_KIT_RATE_LIMIT")) || undefined,
    screenshots: e("REVIEW_KIT_SCREENSHOTS") ? e("REVIEW_KIT_SCREENSHOTS") !== "0" && e("REVIEW_KIT_SCREENSHOTS") !== "false" : undefined,
  };
}

/* ------------------------------------------------------------------ GitHub */

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type GitHubResult<T> = { data: T; headers: Headers };

function github(config: Required<Pick<ReviewKitConfig, "token" | "repo">> & ReviewKitConfig) {
  const doFetch = config.fetch ?? fetch;
  const base = (config.githubApiUrl ?? "https://api.github.com").replace(/\/$/, "");
  return async function call<T>(path: string, init: { method?: string; body?: unknown; root?: boolean } = {}): Promise<GitHubResult<T>> {
    const url = init.root ? `${base}${path}` : `${base}/repos/${config.repo}${path}`;
    const res = await doFetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "review-kit",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `GitHub ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { data, headers: res.headers };
  };
}

type Call = ReturnType<typeof github>;
type Target = { number: number; kind: "pull request" | "issue"; url: string };

export function reviewIssueTitle(branch: string) {
  return `Site review: ${branch}`;
}

async function ensureLabel(gh: Call, name: string) {
  try {
    await gh(`/labels`, { method: "POST", body: { name, color: "fbca04", description: "Comments left with Review Kit" } });
  } catch (error) {
    // 422 = already exists. Anything else: carry on without the label.
    if (!(error instanceof GitHubError) || error.status !== 422) console.warn("[review-kit] could not create label", error);
  }
}

/** The open PR for this branch, or the "Site review" issue for it. */
async function findTarget(gh: Call, config: ReviewKitConfig, branch: string): Promise<Target> {
  if (config.pullRequest) {
    try {
      const { data: pr } = await gh<{ number: number; state: string; html_url: string }>(`/pulls/${config.pullRequest}`);
      if (pr.state === "open") return { number: pr.number, kind: "pull request", url: pr.html_url };
    } catch {
      /* fall through to a branch lookup */
    }
  }
  const owner = config.repo!.split("/")[0];
  if (branch && branch !== "unknown") {
    const { data: prs } = await gh<{ number: number; html_url: string }[]>(
      `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
    );
    if (prs[0]) return { number: prs[0].number, kind: "pull request", url: prs[0].html_url };
  }

  const label = config.issueLabel ?? "review-kit";
  const title = reviewIssueTitle(branch);
  const { data: issues } = await gh<{ number: number; title: string; html_url: string; pull_request?: unknown }[]>(
    `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
  );
  const existing = issues.find((i) => !i.pull_request && i.title === title);
  if (existing) return { number: existing.number, kind: "issue", url: existing.html_url };

  await ensureLabel(gh, label);
  const { data: created } = await gh<{ number: number; html_url: string }>(`/issues`, {
    method: "POST",
    body: {
      title,
      labels: [label],
      body: [
        `Review comments left on the \`${branch}\` site with [Review Kit](https://github.com/tilltonystark/review-kit).`,
        "",
        "Each comment below is one requested change. Claude fixes them on a new branch, opens a pull request, and replies on each comment with the link.",
        "",
        "Ask Claude: **\"check the review inbox\"**.",
      ].join("\n"),
    },
  });
  return { number: created.number, kind: "issue", url: created.html_url };
}

/** Creates the orphan screenshots branch the first time it is needed. */
async function ensureAssetsBranch(gh: Call, branch: string) {
  try {
    await gh(`/git/ref/heads/${branch}`);
    return;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  const { data: tree } = await gh<{ sha: string }>(`/git/trees`, {
    method: "POST",
    body: {
      tree: [
        {
          path: "README.md",
          mode: "100644",
          type: "blob",
          content: "# Review screenshots\n\nScreenshots attached to Review Kit comments. Never deployed or merged. Safe to delete old files.\n",
        },
      ],
    },
  });
  const { data: commit } = await gh<{ sha: string }>(`/git/commits`, {
    method: "POST",
    body: { message: "Start review screenshots branch", tree: tree.sha, parents: [] },
  });
  await gh(`/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
}

async function uploadScreenshot(gh: Call, config: ReviewKitConfig, branch: string, dataUrl: string) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || match[2].length > MAX_SCREENSHOT) return null;
  const assets = config.assetsBranch ?? "review-assets";
  await ensureAssetsBranch(gh, assets);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, "-");
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const path = `shots/${safeBranch}/${stamp}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  await gh(`/contents/${path}`, {
    method: "PUT",
    body: { message: `Review screenshot for ${branch}`, content: match[2], branch: assets },
  });
  return { path, url: `https://github.com/${config.repo}/blob/${assets}/${path}?raw=true` };
}

/* ------------------------------------------------------------- formatting */

type Payload = {
  comment?: unknown;
  page?: { url?: unknown; path?: unknown; title?: unknown };
  element?: Record<string, unknown>;
  device?: Record<string, unknown>;
  screenshot?: unknown;
  capturedAt?: unknown;
  /** Honeypot: humans never fill it. */
  website?: unknown;
};

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (s: string) => (s ? `\`${s.replace(/`/g, "ˋ")}\`` : "–");
/** Stops @mentions and #refs in reviewer text from pinging people or linking issues. */
const defuse = (s: string) => s.replace(/@(?=[a-zA-Z0-9-])/g, "@​");

type Sides = { top: number; right: number; bottom: number; left: number };
function sides(v: unknown): string {
  const s = v as Sides | undefined;
  if (!s || typeof s.top !== "number") return "–";
  const { top, right, bottom, left } = s;
  if (top === right && right === bottom && bottom === left) return `${top}`;
  return `${top} ${right} ${bottom} ${left}`;
}

export function buildCommentBody(
  p: Payload,
  opts: { reviewer?: string; screenshot?: { path: string; url: string } | null; deployment: string },
) {
  const el = (p.element ?? {}) as Record<string, unknown>;
  const box = (el.box ?? {}) as Record<string, unknown>;
  const content = (box.content ?? {}) as { width?: number; height?: number };
  const styles = (el.styles ?? {}) as Record<string, unknown>;
  const device = (p.device ?? {}) as Record<string, unknown>;
  const viewport = (device.viewport ?? {}) as { width?: number; height?: number };
  const comment = defuse(str(p.comment, MAX_COMMENT).trim());
  const path = str(p.page?.path, 300) || "/";
  const url = str(p.page?.url, 500);
  const html = str(el.html, 2600);
  const who = opts.reviewer ? ` from **${cell(opts.reviewer)}**` : "";

  const styleLine = Object.entries(styles)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");

  const lines = [
    `### 💬 Review comment${who} on \`${path.replace(/`/g, "")}\``,
    "",
    comment
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
    "",
    "| | |",
    "| --- | --- |",
    `| **Element** | ${code(str(el.tag, 20))} ${cell(str(el.text, 140) ? `“${defuse(str(el.text, 140))}”` : "")} |`,
    `| **Section** | ${cell(defuse(str(el.section, 160))) || "–"} |`,
    `| **Selector** | ${code(str(el.selector, 400))} |`,
    `| **Size** | ${Number(box.width) || "?"} × ${Number(box.height) || "?"} px (content ${Number(content.width) || "?"} × ${Number(content.height) || "?"}) |`,
    `| **Padding / margin / border** | ${sides(box.padding)} / ${sides(box.margin)} / ${sides(box.border)} px (top right bottom left) |`,
    `| **Styles** | ${cell(styleLine.slice(0, 600)) || "–"} |`,
    `| **Page** | ${url && /^https?:\/\//.test(url) ? `[${cell(path)}](${url.replace(/[()\s]/g, encodeURIComponent)})` : cell(path)} |`,
    `| **Device** | ${Number(viewport.width) || "?"} × ${Number(viewport.height) || "?"} viewport @${Number(device.dpr) || "?"}x · ${cell(str(device.browser, 20))} on ${cell(str(device.os, 20))}${device.touch ? " · touch" : ""} |`,
    `| **Deployment** | ${cell(opts.deployment)} |`,
    "",
  ];
  if (opts.screenshot) lines.push(`<img src="${opts.screenshot.url}" alt="Screenshot of the viewport, selected element outlined in red" width="640">`, "");
  if (html) {
    lines.push("<details><summary>Element HTML</summary>", "", "````html", html.replace(/````/g, "ˋˋˋˋ"), "````", "", "</details>", "");
  }

  // Machine-readable copy for Claude. HTML comments can't contain "--".
  const data = {
    v: 1,
    tool: "review-kit",
    comment,
    reviewer: opts.reviewer ?? null,
    page: { url, path, title: str(p.page?.title, 200) },
    element: { ...el, html: undefined },
    device: { ...device, userAgent: str(device.userAgent, 300) },
    screenshot: opts.screenshot?.path ?? null,
    deployment: opts.deployment,
    capturedAt: str(p.capturedAt, 40),
  };
  lines.push(`<!-- review-kit ${JSON.stringify(data).replace(/--/g, "\\u002d\\u002d").replace(/>/g, "\\u003e")} -->`);
  return lines.join("\n");
}

/* --------------------------------------------------------------- handler */

type Bucket = { count: number; reset: number };
const buckets = new Map<string, Bucket>();

/** Best-effort, per server instance. Serverless hosts may run several. */
function rateLimited(id: string, perHour: number, now = Date.now()): boolean {
  const b = buckets.get(id);
  if (!b || b.reset < now) {
    buckets.set(id, { count: 1, reset: now + 3_600_000 });
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    return false;
  }
  b.count += 1;
  return b.count > perHour;
}

/** Test helper. */
export function _resetRateLimits() {
  buckets.clear();
}

/** Compares strings without leaking where they differ through timing. */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reviewerFor(key: string | null, reviewers: Record<string, string> | undefined): string | null {
  if (!key || !reviewers) return null;
  for (const [name, k] of Object.entries(reviewers)) if (safeEqual(k, key)) return name;
  return null;
}

function tokenKind(token: string): string {
  const kind = token.startsWith("github_pat_")
    ? "fine-grained token"
    : token.startsWith("ghp_")
      ? "classic token (works, but a fine-grained token limited to one repo is safer)"
      : /^gh[ousr]_/.test(token)
        ? "app/OAuth token (won't work here)"
        : "not a GitHub token format";
  return `${kind}, ${token.length} characters`;
}

export type ReviewHandler = (request: Request) => Promise<Response>;

/**
 * Creates the handler. Pass a config, or a function that returns one per
 * request (handy where env vars are only available inside the request, as on
 * Cloudflare Workers).
 */
export function createReviewHandler(input: ReviewKitConfig | ((request: Request) => ReviewKitConfig)): ReviewHandler {
  return async function handle(request: Request): Promise<Response> {
    const config = typeof input === "function" ? input(request) : input;
    const origin = request.headers.get("origin")?.replace(/\/$/, "") ?? null;
    const cors = corsHeaders(config, origin);

    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors, ...extra },
      });

    if (config.disabled) return json({ error: "Not found" }, 404);

    // Cross-site requests are only accepted from allowed origins.
    if (origin && !sameOrigin(request, origin) && !cors["Access-Control-Allow-Origin"]) {
      return json({ error: "This site is not allowed to send review comments here." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Review-Key",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const env = config.environment ?? "production";
    // Production always needs a key. Elsewhere: needed when keys exist, unless
    // turned off for private previews (REVIEW_KIT_REQUIRE_KEY=0).
    const keyRequired = env === "production" || (config.requireKey ?? !!config.reviewers);
    const key = request.headers.get("x-review-key")?.trim() || null;
    const reviewer = reviewerFor(key, config.reviewers);
    const keyOk = !keyRequired || !!reviewer;

    if (request.method === "GET") return json(await setupCheck(config, { keyRequired, keyOk, reviewer, env }));

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    if (keyRequired && !config.reviewers) {
      return json(
        { error: "Review Kit needs reviewer keys on this site. Add REVIEW_KIT_REVIEWERS (see the guide), then redeploy.", code: "no_reviewers" },
        503,
      );
    }
    if (!keyOk) {
      return json({ error: key ? "That review key is not valid (it may have been removed)." : "Enter your review key to send comments.", code: "bad_key" }, 401);
    }
    if (!config.token) {
      return json(
        { error: "Review Kit has no GitHub token on this site yet. Add REVIEW_KIT_GITHUB_TOKEN on the server, then redeploy.", code: "no_token" },
        503,
      );
    }
    if (!config.repo) {
      return json({ error: "Review Kit doesn't know which GitHub repo to use. Set REVIEW_KIT_REPO to owner/name.", code: "no_repo" }, 503);
    }

    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return json({ error: "That comment is too large to send. Try without a screenshot.", code: "too_large" }, 413);

    let payload: Payload;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ error: "That comment is too large to send.", code: "too_large" }, 413);
      payload = JSON.parse(text) as Payload;
    } catch {
      return json({ error: "Invalid request.", code: "bad_json" }, 400);
    }

    // Honeypot filled in: a bot. Pretend it worked.
    if (str(payload.website)) return json({ url: null, target: "issue", screenshot: false });

    if (!str(payload.comment, MAX_COMMENT).trim() || typeof payload.element !== "object" || !payload.element) {
      return json({ error: "Write a comment first.", code: "empty" }, 400);
    }

    const limitId = reviewer ? `r:${reviewer}` : `ip:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("cf-connecting-ip") ?? "anon"}`;
    if (rateLimited(limitId, config.rateLimitPerHour ?? 20)) {
      return json({ error: "That's a lot of comments in one hour. Please wait a bit and try again.", code: "rate_limited" }, 429);
    }

    const branch = config.branch || (env === "production" ? "production" : "unknown");
    const deployment = `\`${branch}\`${config.commit ? ` @ ${config.commit.slice(0, 7)}` : ""}${config.deploymentUrl ? ` · ${config.deploymentUrl}` : ""} · ${env}`;
    const gh = github({ ...config, token: config.token, repo: config.repo });

    try {
      const target = await findTarget(gh, config, branch);
      let shot: { path: string; url: string } | null = null;
      if (config.screenshots !== false && typeof payload.screenshot === "string") {
        try {
          shot = await uploadScreenshot(gh, config, branch, payload.screenshot);
        } catch (error) {
          console.warn("[review-kit] screenshot upload failed", error);
        }
      }
      const { data: created } = await gh<{ html_url: string }>(`/issues/${target.number}/comments`, {
        method: "POST",
        body: { body: buildCommentBody(payload, { reviewer: reviewer ?? undefined, screenshot: shot, deployment }) },
      });
      return json({ url: created.html_url, target: target.kind, targetUrl: target.url, screenshot: !!shot });
    } catch (error) {
      console.error("[review-kit] posting failed", error);
      const status = error instanceof GitHubError ? error.status : 0;
      const [hint, code] =
        status === 401
          ? ["The GitHub token is invalid or has expired. Make a new one (see the guide) and replace it on the server.", "token_invalid"]
          : status === 403 || status === 404
            ? ["The GitHub token can't write to this repository. Check it has Issues, Pull requests and Contents set to read and write.", "token_forbidden"]
            : status === 410
              ? ["Issues are turned off for this repository. Turn them on in the repo's Settings > General > Features.", "issues_disabled"]
              : ["Could not reach GitHub. Your comment is saved in this browser; try again in a minute.", "github_unreachable"];
      return json({ error: hint, code }, 502);
    }
  };
}

function sameOrigin(request: Request, origin: string) {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
    return new URL(origin).host === host || new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

function corsHeaders(config: ReviewKitConfig, origin: string | null): Record<string, string> {
  if (!origin || !config.allowedOrigins?.length) return {};
  if (!config.allowedOrigins.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

/** What the widget and a person in a browser see at GET. No secrets. */
async function setupCheck(
  config: ReviewKitConfig,
  ctx: { keyRequired: boolean; keyOk: boolean; reviewer: string | null; env: Environment },
) {
  const base = { version: VERSION, environment: ctx.env, keyRequired: ctx.keyRequired, keyValid: ctx.keyOk };
  // Without a valid key on a gated site, say only that a key is needed.
  if (!ctx.keyOk) return { ...base, ready: false, problem: "Enter your review key." };

  const problems: string[] = [];
  let tokenExpires: string | null = null;
  let githubStatus = "not checked";
  if (ctx.keyRequired && !config.reviewers) problems.push("No reviewer keys are set (REVIEW_KIT_REVIEWERS).");
  if (!config.repo) problems.push("No repo is set (REVIEW_KIT_REPO).");
  if (!config.token) problems.push("No GitHub token is set (REVIEW_KIT_GITHUB_TOKEN).");

  if (config.token && config.repo) {
    try {
      const gh = github({ ...config, token: config.token, repo: config.repo });
      const { data, headers } = await gh<{ permissions?: { push?: boolean }; has_issues?: boolean }>("");
      tokenExpires = headers.get("github-authentication-token-expiration");
      if (data.permissions?.push === false) problems.push("The token can read the repo but not write to it.");
      if (data.has_issues === false) problems.push("Issues are turned off for this repo.");
      githubStatus = "ok";
    } catch (error) {
      githubStatus = "error";
      const status = error instanceof GitHubError ? error.status : 0;
      problems.push(
        status === 401
          ? "The GitHub token is invalid or has expired."
          : status === 403 || status === 404
            ? `The token can't see ${config.repo}. Check the repo is selected on the token.`
            : "GitHub could not be reached.",
      );
    }
  }

  let warning: string | null = null;
  if (tokenExpires) {
    const days = Math.floor((Date.parse(tokenExpires) - Date.now()) / 86_400_000);
    if (Number.isFinite(days) && days <= 14) warning = `The GitHub token expires in ${Math.max(0, days)} day${days === 1 ? "" : "s"}. Make a new one soon.`;
  }

  return {
    ...base,
    ready: problems.length === 0,
    problem: problems[0] ?? null,
    problems,
    warning,
    reviewer: ctx.reviewer,
    repo: config.repo ?? null,
    branch: config.branch ?? null,
    token: config.token ? tokenKind(config.token) : null,
    tokenExpires,
    github: githubStatus,
    screenshots: config.screenshots !== false,
  };
}
