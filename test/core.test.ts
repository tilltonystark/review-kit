import { beforeEach, describe, expect, it } from "vitest";
import { _resetRateLimits, buildCommentBody, cleanToken, configFromEnv, createReviewHandler, parseReviewers, type ReviewKitConfig } from "../server/core";

type Route = { method: string; path: RegExp; status?: number; body?: unknown; headers?: Record<string, string> };

/** A fake GitHub: answers by method + path, records every call. */
function fakeGitHub(routes: Route[]) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "") + url.search;
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find((r) => r.method === method && r.path.test(path));
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: route.headers });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const element = { tag: "h1", selector: "body > h1", text: "Hello", box: { width: 100, height: 40 } };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://site.test/api/review-kit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const base: ReviewKitConfig = { token: "github_pat_x", repo: "me/site", branch: "feature", environment: "preview" };

beforeEach(() => _resetRateLimits());

describe("routing", () => {
  it("comments on the open PR for the branch", async () => {
    const gh = fakeGitHub([
      { method: "GET", path: /^\/pulls\?state=open&head=me%3Afeature/, body: [{ number: 7, html_url: "https://github.com/me/site/pull/7" }] },
      { method: "POST", path: /^\/issues\/7\/comments$/, body: { html_url: "https://github.com/me/site/pull/7#c1" } },
    ]);
    const res = await createReviewHandler({ ...base, fetch: gh.fetchFn })(post({ comment: "Bigger please", element }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ target: "pull request", url: "https://github.com/me/site/pull/7#c1" });
    expect(gh.calls.at(-1)!.body.body).toContain("> Bigger please");
  });

  it("falls back to a labelled Site review issue when there is no PR, and creates it once", async () => {
    const gh = fakeGitHub([
      { method: "GET", path: /^\/pulls\?/, body: [] },
      { method: "GET", path: /^\/issues\?state=open&labels=review-kit/, body: [] },
      { method: "POST", path: /^\/labels$/, status: 201 },
      { method: "POST", path: /^\/issues$/, status: 201, body: { number: 3, html_url: "https://github.com/me/site/issues/3" } },
      { method: "POST", path: /^\/issues\/3\/comments$/, body: { html_url: "https://github.com/me/site/issues/3#c1" } },
    ]);
    const res = await createReviewHandler({ ...base, branch: "main", fetch: gh.fetchFn })(post({ comment: "x", element }));
    expect(await res.json()).toMatchObject({ target: "issue" });
    const created = gh.calls.find((c) => c.method === "POST" && c.path === "/issues")!;
    expect(created.body).toMatchObject({ title: "Site review: main", labels: ["review-kit"] });
  });

  it("reuses an existing Site review issue", async () => {
    const gh = fakeGitHub([
      { method: "GET", path: /^\/pulls\?/, body: [] },
      { method: "GET", path: /^\/issues\?/, body: [{ number: 9, title: "Site review: main", html_url: "u" }] },
      { method: "POST", path: /^\/issues\/9\/comments$/, body: { html_url: "c" } },
    ]);
    const res = await createReviewHandler({ ...base, branch: "main", fetch: gh.fetchFn })(post({ comment: "x", element }));
    expect(res.status).toBe(200);
    expect(gh.calls.some((c) => c.method === "POST" && c.path === "/issues")).toBe(false);
  });

  it("uses 'production' as the issue name on a live site without a branch", async () => {
    const gh = fakeGitHub([
      { method: "GET", path: /^\/pulls\?/, body: [] },
      { method: "GET", path: /^\/issues\?/, body: [{ number: 2, title: "Site review: production", html_url: "u" }] },
      { method: "POST", path: /^\/issues\/2\/comments$/, body: { html_url: "c" } },
    ]);
    const handler = createReviewHandler({ ...base, branch: undefined, environment: "production", reviewers: { Om: "k_12345678" }, fetch: gh.fetchFn });
    const res = await handler(post({ comment: "x", element }, { "X-Review-Key": "k_12345678" }));
    expect(res.status).toBe(200);
    expect(gh.calls.at(-1)!.body.body).toContain("from **Om**");
  });
});

describe("safety", () => {
  it("refuses production comments without a key", async () => {
    const res = await createReviewHandler({ ...base, environment: "production", reviewers: { Om: "k_12345678" } })(post({ comment: "x", element }));
    expect(res.status).toBe(401);
  });

  it("refuses a wrong key", async () => {
    const res = await createReviewHandler({ ...base, reviewers: { Om: "k_12345678" } })(post({ comment: "x", element }, { "X-Review-Key": "k_00000000" }));
    expect(res.status).toBe(401);
  });

  it("says keys are missing on production when none are set", async () => {
    const res = await createReviewHandler({ ...base, environment: "production" })(post({ comment: "x", element }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("no_reviewers");
  });

  it("explains a missing token", async () => {
    const res = await createReviewHandler({ ...base, token: undefined })(post({ comment: "x", element }));
    expect((await res.json()).code).toBe("no_token");
  });

  it("explains an expired token", async () => {
    const gh = fakeGitHub([{ method: "GET", path: /^\/pulls/, status: 401 }]);
    const res = await createReviewHandler({ ...base, fetch: gh.fetchFn })(post({ comment: "x", element }));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("token_invalid");
  });

  it("rejects other sites unless allowed, and answers CORS for allowed ones", async () => {
    const handler = createReviewHandler({ ...base, allowedOrigins: ["https://good.test"] });
    const bad = await handler(post({ comment: "x", element }, { Origin: "https://evil.test" }));
    expect(bad.status).toBe(403);
    const pre = await handler(new Request("https://relay.test/", { method: "OPTIONS", headers: { Origin: "https://good.test" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://good.test");
  });

  it("accepts same-origin requests", async () => {
    const gh = fakeGitHub([
      { method: "GET", path: /^\/pulls\?/, body: [{ number: 1, html_url: "u" }] },
      { method: "POST", path: /comments$/, body: { html_url: "c" } },
    ]);
    const res = await createReviewHandler({ ...base, fetch: gh.fetchFn })(post({ comment: "x", element }, { Origin: "https://site.test" }));
    expect(res.status).toBe(200);
  });

  it("drops bot submissions silently", async () => {
    const gh = fakeGitHub([]);
    const res = await createReviewHandler({ ...base, fetch: gh.fetchFn })(post({ comment: "buy now", element, website: "spam.example" }));
    expect(res.status).toBe(200);
    expect(gh.calls).toHaveLength(0);
  });

  it("rate limits per reviewer", async () => {
    const gh = fakeGitHub([
      { method: "GET", path: /^\/pulls\?/, body: [{ number: 1, html_url: "u" }] },
      { method: "POST", path: /comments$/, body: { html_url: "c" } },
    ]);
    const handler = createReviewHandler({ ...base, rateLimitPerHour: 2, reviewers: { Om: "k_12345678" }, fetch: gh.fetchFn });
    const h = { "X-Review-Key": "k_12345678" };
    expect((await handler(post({ comment: "1", element }, h))).status).toBe(200);
    expect((await handler(post({ comment: "2", element }, h))).status).toBe(200);
    expect((await handler(post({ comment: "3", element }, h))).status).toBe(429);
  });

  it("is invisible when disabled", async () => {
    const res = await createReviewHandler({ ...base, disabled: true })(new Request("https://site.test/api/review-kit"));
    expect(res.status).toBe(404);
  });

  it("neutralises @mentions so reviewers can't ping strangers", () => {
    const body = buildCommentBody({ comment: "cc @octocat", element }, { deployment: "x" });
    expect(body).not.toContain("@octocat");
  });
});

describe("setup check", () => {
  it("never shows the token and warns before it expires", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const gh = fakeGitHub([{ method: "GET", path: /^$/, body: { permissions: { push: true } }, headers: { "github-authentication-token-expiration": soon } }]);
    const res = await createReviewHandler({ ...base, fetch: gh.fetchFn })(new Request("https://site.test/api/review-kit"));
    const text = await res.text();
    expect(text).not.toContain("github_pat_x");
    const data = JSON.parse(text);
    expect(data.ready).toBe(true);
    expect(data.warning).toMatch(/expires in [45] days/);
  });

  it("tells a visitor without a key nothing about the setup", async () => {
    const res = await createReviewHandler({ ...base, environment: "production", reviewers: { Om: "k_12345678" } })(new Request("https://site.test/api/review-kit"));
    const data = await res.json();
    expect(data).toMatchObject({ ready: false, keyRequired: true, keyValid: false });
    expect(data.repo).toBeUndefined();
  });
});

describe("config", () => {
  it("reads Vercel variables", () => {
    const c = configFromEnv({ VERCEL_ENV: "preview", VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "site", VERCEL_GIT_COMMIT_REF: "feat", GITHUB_REVIEW_TOKEN: " Bearer github_pat_abc " });
    expect(c).toMatchObject({ environment: "preview", repo: "me/site", branch: "feat", token: "github_pat_abc" });
  });
  it("reads Netlify variables", () => {
    const c = configFromEnv({ CONTEXT: "deploy-preview", REPOSITORY_URL: "https://github.com/me/site", HEAD: "feat", REVIEW_ID: "12" });
    expect(c).toMatchObject({ environment: "preview", repo: "me/site", branch: "feat", pullRequest: 12 });
  });
  it("treats an unknown host as production (keys required)", () => {
    expect(configFromEnv({}).environment).toBe("production");
  });
  it("parses reviewers and ignores short keys", () => {
    expect(parseReviewers("Om:k_12345678, Bad:123, Satyam: k_abcdefgh")).toEqual({ Om: "k_12345678", Satyam: "k_abcdefgh" });
  });
  it("cleans pasted tokens", () => {
    expect(cleanToken(' "token ghp_x" ')).toBe("ghp_x");
  });
});
