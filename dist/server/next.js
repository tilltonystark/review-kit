// server/core.ts
var VERSION = "0.1.0";
var MAX_COMMENT = 4e3;
var MAX_SCREENSHOT = 3e6;
var MAX_BODY = 4e6;
function cleanToken(raw) {
  if (!raw) return void 0;
  const token = raw.trim().replace(/^["']|["']$/g, "").replace(/^(bearer|token)\s+/i, "").trim();
  return token || void 0;
}
function parseReviewers(raw) {
  if (!raw?.trim()) return void 0;
  const out = {};
  for (const part of raw.split(/[,\n]/)) {
    const i = part.lastIndexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const key = part.slice(i + 1).trim();
    if (name && key.length >= 8) out[name] = key;
  }
  return Object.keys(out).length ? out : void 0;
}
function repoFromUrl(url) {
  const m = url && /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : void 0;
}
function configFromEnv(env) {
  const e = (k) => env[k]?.trim() || void 0;
  const repo = e("REVIEW_KIT_REPO") || (e("VERCEL_GIT_REPO_OWNER") && e("VERCEL_GIT_REPO_SLUG") ? `${e("VERCEL_GIT_REPO_OWNER")}/${e("VERCEL_GIT_REPO_SLUG")}` : void 0) || repoFromUrl(e("REPOSITORY_URL")) || // Netlify
  repoFromUrl(e("RENDER_GIT_REPO_SLUG") ? `github.com/${e("RENDER_GIT_REPO_SLUG")}` : void 0) || e("GITHUB_REPOSITORY");
  const branch = e("REVIEW_KIT_BRANCH") || e("VERCEL_GIT_COMMIT_REF") || e("HEAD") || // Netlify
  e("CF_PAGES_BRANCH") || e("RENDER_GIT_BRANCH") || e("GITHUB_REF_NAME");
  const commit = e("REVIEW_KIT_COMMIT") || e("VERCEL_GIT_COMMIT_SHA") || e("COMMIT_REF") || e("CF_PAGES_COMMIT_SHA") || e("RENDER_GIT_COMMIT");
  let environment;
  const forced = e("REVIEW_KIT_ENV");
  if (forced === "production" || forced === "preview" || forced === "development") environment = forced;
  else if (e("VERCEL_ENV")) environment = e("VERCEL_ENV") === "production" ? "production" : e("VERCEL_ENV") === "preview" ? "preview" : "development";
  else if (e("CONTEXT")) environment = e("CONTEXT") === "production" ? "production" : e("CONTEXT") === "dev" ? "development" : "preview";
  else if (e("CF_PAGES")) environment = branch && branch === (e("REVIEW_KIT_PRODUCTION_BRANCH") ?? "main") ? "production" : "preview";
  else if (e("NODE_ENV") === "development") environment = "development";
  environment ??= "production";
  const pr = Number(e("REVIEW_KIT_PR") || e("VERCEL_GIT_PULL_REQUEST_ID") || e("REVIEW_ID"));
  const deploymentUrl = e("REVIEW_KIT_DEPLOYMENT_URL") || (e("VERCEL_URL") ? `https://${e("VERCEL_URL")}` : void 0) || e("DEPLOY_PRIME_URL") || e("CF_PAGES_URL") || e("RENDER_EXTERNAL_URL");
  const origins = e("REVIEW_KIT_ALLOWED_ORIGINS");
  return {
    token: cleanToken(e("REVIEW_KIT_GITHUB_TOKEN") || e("GITHUB_REVIEW_TOKEN")),
    repo,
    branch,
    commit,
    pullRequest: Number.isFinite(pr) && pr > 0 ? pr : void 0,
    environment,
    deploymentUrl,
    reviewers: parseReviewers(e("REVIEW_KIT_REVIEWERS")),
    requireKey: e("REVIEW_KIT_REQUIRE_KEY") ? e("REVIEW_KIT_REQUIRE_KEY") === "1" || e("REVIEW_KIT_REQUIRE_KEY") === "true" : void 0,
    disabled: e("REVIEW_KIT_DISABLED") === "1" || e("REVIEW_KIT_DISABLED") === "true",
    allowedOrigins: origins ? origins.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean) : void 0,
    rateLimitPerHour: Number(e("REVIEW_KIT_RATE_LIMIT")) || void 0,
    screenshots: e("REVIEW_KIT_SCREENSHOTS") ? e("REVIEW_KIT_SCREENSHOTS") !== "0" && e("REVIEW_KIT_SCREENSHOTS") !== "false" : void 0
  };
}
var GitHubError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function github(config) {
  const doFetch = config.fetch ?? fetch;
  const base = (config.githubApiUrl ?? "https://api.github.com").replace(/\/$/, "");
  return async function call(path, init = {}) {
    const url = init.root ? `${base}${path}` : `${base}/repos/${config.repo}${path}`;
    const res = await doFetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "review-kit",
        ...init.body ? { "Content-Type": "application/json" } : {}
      },
      body: init.body ? JSON.stringify(init.body) : void 0,
      signal: AbortSignal.timeout(15e3)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `GitHub ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = res.status === 204 ? void 0 : await res.json();
    return { data, headers: res.headers };
  };
}
function reviewIssueTitle(branch) {
  return `Site review: ${branch}`;
}
async function ensureLabel(gh, name) {
  try {
    await gh(`/labels`, { method: "POST", body: { name, color: "fbca04", description: "Comments left with Review Kit" } });
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) console.warn("[review-kit] could not create label", error);
  }
}
async function findTarget(gh, config, branch) {
  if (config.pullRequest) {
    try {
      const { data: pr } = await gh(`/pulls/${config.pullRequest}`);
      if (pr.state === "open") return { number: pr.number, kind: "pull request", url: pr.html_url };
    } catch {
    }
  }
  const owner = config.repo.split("/")[0];
  if (branch && branch !== "unknown") {
    const { data: prs } = await gh(
      `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`
    );
    if (prs[0]) return { number: prs[0].number, kind: "pull request", url: prs[0].html_url };
  }
  const label = config.issueLabel ?? "review-kit";
  const title = reviewIssueTitle(branch);
  const { data: issues } = await gh(
    `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`
  );
  const existing = issues.find((i) => !i.pull_request && i.title === title);
  if (existing) return { number: existing.number, kind: "issue", url: existing.html_url };
  await ensureLabel(gh, label);
  const { data: created } = await gh(`/issues`, {
    method: "POST",
    body: {
      title,
      labels: [label],
      body: [
        `Review comments left on the \`${branch}\` site with [Review Kit](https://github.com/tilltonystark/review-kit).`,
        "",
        "Each comment below is one requested change. Claude fixes them on a new branch, opens a pull request, and replies on each comment with the link.",
        "",
        'Ask Claude: **"check the review inbox"**.'
      ].join("\n")
    }
  });
  return { number: created.number, kind: "issue", url: created.html_url };
}
async function ensureAssetsBranch(gh, branch) {
  try {
    await gh(`/git/ref/heads/${branch}`);
    return;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  const { data: tree } = await gh(`/git/trees`, {
    method: "POST",
    body: {
      tree: [
        {
          path: "README.md",
          mode: "100644",
          type: "blob",
          content: "# Review screenshots\n\nScreenshots attached to Review Kit comments. Never deployed or merged. Safe to delete old files.\n"
        }
      ]
    }
  });
  const { data: commit } = await gh(`/git/commits`, {
    method: "POST",
    body: { message: "Start review screenshots branch", tree: tree.sha, parents: [] }
  });
  await gh(`/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
}
async function uploadScreenshot(gh, config, branch, dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || match[2].length > MAX_SCREENSHOT) return null;
  const assets = config.assetsBranch ?? "review-assets";
  await ensureAssetsBranch(gh, assets);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, "-");
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const path = `shots/${safeBranch}/${stamp}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  await gh(`/contents/${path}`, {
    method: "PUT",
    body: { message: `Review screenshot for ${branch}`, content: match[2], branch: assets }
  });
  return { path, url: `https://github.com/${config.repo}/blob/${assets}/${path}?raw=true` };
}
var str = (v, max = 500) => typeof v === "string" ? v.slice(0, max) : "";
var cell = (s) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
var code = (s) => s ? `\`${s.replace(/`/g, "\u02CB")}\`` : "\u2013";
var defuse = (s) => s.replace(/@(?=[a-zA-Z0-9-])/g, "@\u200B");
function sides(v) {
  const s = v;
  if (!s || typeof s.top !== "number") return "\u2013";
  const { top, right, bottom, left } = s;
  if (top === right && right === bottom && bottom === left) return `${top}`;
  return `${top} ${right} ${bottom} ${left}`;
}
function buildCommentBody(p, opts) {
  const el = p.element ?? {};
  const box = el.box ?? {};
  const content = box.content ?? {};
  const styles = el.styles ?? {};
  const device = p.device ?? {};
  const viewport = device.viewport ?? {};
  const comment = defuse(str(p.comment, MAX_COMMENT).trim());
  const path = str(p.page?.path, 300) || "/";
  const url = str(p.page?.url, 500);
  const html = str(el.html, 2600);
  const who = opts.reviewer ? ` from **${cell(opts.reviewer)}**` : "";
  const styleLine = Object.entries(styles).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}: ${v}`).join("; ");
  const lines = [
    `### \u{1F4AC} Review comment${who} on \`${path.replace(/`/g, "")}\``,
    "",
    comment.split("\n").map((l) => `> ${l}`).join("\n"),
    "",
    "| | |",
    "| --- | --- |",
    `| **Element** | ${code(str(el.tag, 20))} ${cell(str(el.text, 140) ? `\u201C${defuse(str(el.text, 140))}\u201D` : "")} |`,
    `| **Section** | ${cell(defuse(str(el.section, 160))) || "\u2013"} |`,
    `| **Selector** | ${code(str(el.selector, 400))} |`,
    `| **Size** | ${Number(box.width) || "?"} \xD7 ${Number(box.height) || "?"} px (content ${Number(content.width) || "?"} \xD7 ${Number(content.height) || "?"}) |`,
    `| **Padding / margin / border** | ${sides(box.padding)} / ${sides(box.margin)} / ${sides(box.border)} px (top right bottom left) |`,
    `| **Styles** | ${cell(styleLine.slice(0, 600)) || "\u2013"} |`,
    `| **Page** | ${url && /^https?:\/\//.test(url) ? `[${cell(path)}](${url.replace(/[()\s]/g, encodeURIComponent)})` : cell(path)} |`,
    `| **Device** | ${Number(viewport.width) || "?"} \xD7 ${Number(viewport.height) || "?"} viewport @${Number(device.dpr) || "?"}x \xB7 ${cell(str(device.browser, 20))} on ${cell(str(device.os, 20))}${device.touch ? " \xB7 touch" : ""} |`,
    `| **Deployment** | ${cell(opts.deployment)} |`,
    ""
  ];
  if (opts.screenshot) lines.push(`<img src="${opts.screenshot.url}" alt="Screenshot of the viewport, selected element outlined in red" width="640">`, "");
  if (html) {
    lines.push("<details><summary>Element HTML</summary>", "", "````html", html.replace(/````/g, "\u02CB\u02CB\u02CB\u02CB"), "````", "", "</details>", "");
  }
  const data = {
    v: 1,
    tool: "review-kit",
    comment,
    reviewer: opts.reviewer ?? null,
    page: { url, path, title: str(p.page?.title, 200) },
    element: { ...el, html: void 0 },
    device: { ...device, userAgent: str(device.userAgent, 300) },
    screenshot: opts.screenshot?.path ?? null,
    deployment: opts.deployment,
    capturedAt: str(p.capturedAt, 40)
  };
  lines.push(`<!-- review-kit ${JSON.stringify(data).replace(/--/g, "\\u002d\\u002d").replace(/>/g, "\\u003e")} -->`);
  return lines.join("\n");
}
var buckets = /* @__PURE__ */ new Map();
function rateLimited(id, perHour, now = Date.now()) {
  const b = buckets.get(id);
  if (!b || b.reset < now) {
    buckets.set(id, { count: 1, reset: now + 36e5 });
    if (buckets.size > 5e3) {
      for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    }
    return false;
  }
  b.count += 1;
  return b.count > perHour;
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function reviewerFor(key, reviewers) {
  if (!key || !reviewers) return null;
  for (const [name, k] of Object.entries(reviewers)) if (safeEqual(k, key)) return name;
  return null;
}
function tokenKind(token) {
  const kind = token.startsWith("github_pat_") ? "fine-grained token" : token.startsWith("ghp_") ? "classic token (works, but a fine-grained token limited to one repo is safer)" : /^gh[ousr]_/.test(token) ? "app/OAuth token (won't work here)" : "not a GitHub token format";
  return `${kind}, ${token.length} characters`;
}
function createReviewHandler(input) {
  return async function handle(request) {
    const config = typeof input === "function" ? input(request) : input;
    const origin = request.headers.get("origin")?.replace(/\/$/, "") ?? null;
    const cors = corsHeaders(config, origin);
    const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors, ...extra }
    });
    if (config.disabled) return json({ error: "Not found" }, 404);
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
          "Access-Control-Max-Age": "86400"
        }
      });
    }
    const env = config.environment ?? "production";
    const keyRequired = env === "production" || (config.requireKey ?? !!config.reviewers);
    const key = request.headers.get("x-review-key")?.trim() || null;
    const reviewer = reviewerFor(key, config.reviewers);
    const keyOk = !keyRequired || !!reviewer;
    if (request.method === "GET") return json(await setupCheck(config, { keyRequired, keyOk, reviewer, env }));
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (keyRequired && !config.reviewers) {
      return json(
        { error: "Review Kit needs reviewer keys on this site. Add REVIEW_KIT_REVIEWERS (see the guide), then redeploy.", code: "no_reviewers" },
        503
      );
    }
    if (!keyOk) {
      return json({ error: key ? "That review key is not valid (it may have been removed)." : "Enter your review key to send comments.", code: "bad_key" }, 401);
    }
    if (!config.token) {
      return json(
        { error: "Review Kit has no GitHub token on this site yet. Add REVIEW_KIT_GITHUB_TOKEN on the server, then redeploy.", code: "no_token" },
        503
      );
    }
    if (!config.repo) {
      return json({ error: "Review Kit doesn't know which GitHub repo to use. Set REVIEW_KIT_REPO to owner/name.", code: "no_repo" }, 503);
    }
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return json({ error: "That comment is too large to send. Try without a screenshot.", code: "too_large" }, 413);
    let payload;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ error: "That comment is too large to send.", code: "too_large" }, 413);
      payload = JSON.parse(text);
    } catch {
      return json({ error: "Invalid request.", code: "bad_json" }, 400);
    }
    if (str(payload.website)) return json({ url: null, target: "issue", screenshot: false });
    if (!str(payload.comment, MAX_COMMENT).trim() || typeof payload.element !== "object" || !payload.element) {
      return json({ error: "Write a comment first.", code: "empty" }, 400);
    }
    const limitId = reviewer ? `r:${reviewer}` : `ip:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("cf-connecting-ip") ?? "anon"}`;
    if (rateLimited(limitId, config.rateLimitPerHour ?? 20)) {
      return json({ error: "That's a lot of comments in one hour. Please wait a bit and try again.", code: "rate_limited" }, 429);
    }
    const branch = config.branch || (env === "production" ? "production" : "unknown");
    const deployment = `\`${branch}\`${config.commit ? ` @ ${config.commit.slice(0, 7)}` : ""}${config.deploymentUrl ? ` \xB7 ${config.deploymentUrl}` : ""} \xB7 ${env}`;
    const gh = github({ ...config, token: config.token, repo: config.repo });
    try {
      const target = await findTarget(gh, config, branch);
      let shot = null;
      if (config.screenshots !== false && typeof payload.screenshot === "string") {
        try {
          shot = await uploadScreenshot(gh, config, branch, payload.screenshot);
        } catch (error) {
          console.warn("[review-kit] screenshot upload failed", error);
        }
      }
      const { data: created } = await gh(`/issues/${target.number}/comments`, {
        method: "POST",
        body: { body: buildCommentBody(payload, { reviewer: reviewer ?? void 0, screenshot: shot, deployment }) }
      });
      return json({ url: created.html_url, target: target.kind, targetUrl: target.url, screenshot: !!shot });
    } catch (error) {
      console.error("[review-kit] posting failed", error);
      const status = error instanceof GitHubError ? error.status : 0;
      const [hint, code2] = status === 401 ? ["The GitHub token is invalid or has expired. Make a new one (see the guide) and replace it on the server.", "token_invalid"] : status === 403 || status === 404 ? ["The GitHub token can't write to this repository. Check it has Issues, Pull requests and Contents set to read and write.", "token_forbidden"] : status === 410 ? ["Issues are turned off for this repository. Turn them on in the repo's Settings > General > Features.", "issues_disabled"] : ["Could not reach GitHub. Your comment is saved in this browser; try again in a minute.", "github_unreachable"];
      return json({ error: hint, code: code2 }, 502);
    }
  };
}
function sameOrigin(request, origin) {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
    return new URL(origin).host === host || new URL(origin).host === url.host;
  } catch {
    return false;
  }
}
function corsHeaders(config, origin) {
  if (!origin || !config.allowedOrigins?.length) return {};
  if (!config.allowedOrigins.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}
async function setupCheck(config, ctx) {
  const base = { version: VERSION, environment: ctx.env, keyRequired: ctx.keyRequired, keyValid: ctx.keyOk };
  if (!ctx.keyOk) return { ...base, ready: false, problem: "Enter your review key." };
  const problems = [];
  let tokenExpires = null;
  let githubStatus = "not checked";
  if (ctx.keyRequired && !config.reviewers) problems.push("No reviewer keys are set (REVIEW_KIT_REVIEWERS).");
  if (!config.repo) problems.push("No repo is set (REVIEW_KIT_REPO).");
  if (!config.token) problems.push("No GitHub token is set (REVIEW_KIT_GITHUB_TOKEN).");
  if (config.token && config.repo) {
    try {
      const gh = github({ ...config, token: config.token, repo: config.repo });
      const { data, headers } = await gh("");
      tokenExpires = headers.get("github-authentication-token-expiration");
      if (data.permissions?.push === false) problems.push("The token can read the repo but not write to it.");
      if (data.has_issues === false) problems.push("Issues are turned off for this repo.");
      githubStatus = "ok";
    } catch (error) {
      githubStatus = "error";
      const status = error instanceof GitHubError ? error.status : 0;
      problems.push(
        status === 401 ? "The GitHub token is invalid or has expired." : status === 403 || status === 404 ? `The token can't see ${config.repo}. Check the repo is selected on the token.` : "GitHub could not be reached."
      );
    }
  }
  let warning = null;
  if (tokenExpires) {
    const days = Math.floor((Date.parse(tokenExpires) - Date.now()) / 864e5);
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
    screenshots: config.screenshots !== false
  };
}

// server/next.ts
var handler = createReviewHandler(() => configFromEnv(process.env));
var dynamic = "force-dynamic";
var GET = handler;
var POST = handler;
var OPTIONS = handler;
export {
  GET,
  OPTIONS,
  POST,
  dynamic
};
