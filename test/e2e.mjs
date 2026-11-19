// Browser test: a static page + the node adapter + a fake GitHub.
// Run after `npm run build`: node test/e2e.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
import { reviewKitMiddleware } from "../dist/server/node.js";

const posted = [];
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (method === "POST" && /\/comments$/.test(u.pathname)) {
    posted.push(body.body);
    return Response.json({ html_url: "https://github.com/me/site/pull/1#issuecomment-1" });
  }
  if (method === "GET" && u.pathname.endsWith("/pulls")) return Response.json([{ number: 1, html_url: "https://github.com/me/site/pull/1" }]);
  if (method === "GET" && u.pathname === "/repos/me/site") return Response.json({ permissions: { push: true } });
  if (u.pathname.includes("/git/ref/")) return Response.json({});
  if (method === "PUT" && u.pathname.includes("/contents/")) return Response.json({});
  return new Response("{}", { status: 404 });
};

const api = reviewKitMiddleware({ token: "github_pat_test", repo: "me/site", branch: "feature", environment: "preview", fetch: fakeFetch });
const types = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/api/review-kit")) return api(req, res);
  const file = req.url.startsWith("/review-kit/") ? join("dist/widget", req.url.slice(12)) : "examples/static/index.html";
  try {
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(4317);

const browser = await chromium.launch();
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };

for (const [name, ctxOpts] of [["desktop", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }], ["phone", devices["iPhone 13"]]]) {
  const before = posted.length;
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check(false, `${name}: page error ${e.message}`));
  await page.goto("http://localhost:4317/");
  const host = page.locator("review-kit-root");
  await host.locator("button.main").waitFor();
  await page.screenshot({ path: `test/out-${name}-1-idle.png` });
  await host.locator("button.main").click();
  await page.locator("button.cta").click(); // must select, not navigate
  check(page.url() === "http://localhost:4317/", `${name}: clicking a link while picking does not navigate`);
  await host.locator("textarea").waitFor();
  await page.waitForTimeout(300);
  await host.locator("textarea").fill("Make this button bigger");
  await page.screenshot({ path: `test/out-${name}-2-compose.png` });
  await host.locator("button.send").click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `test/out-${name}-3-sent.png` });
  check(posted.length === before + 1, `${name}: comment reached GitHub`);
  const body = posted.at(-1) ?? "";
  check(body.includes("> Make this button bigger") && body.includes("button.cta") || body.includes("`button`"), `${name}: comment has text and element`);
  check(body.includes("<img src="), `${name}: screenshot attached`);
  await ctx.close();
}

// Live-site mode: without a key nothing loads.
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.route("**/", async (route) => {
  const html = (await readFile("examples/static/index.html", "utf8")).replace('data-endpoint', 'data-require-key="true" data-endpoint');
  route.fulfill({ body: html, contentType: "text/html" });
});
await page.goto("http://localhost:4317/");
await page.waitForTimeout(800);
check((await page.locator("review-kit-root").count()) === 0, "live site: hidden for visitors without a key");
await page.goto("http://localhost:4317/?review-key=k_12345678");
await page.locator("review-kit-root").locator("button.main").waitFor({ timeout: 5000 });
check(!page.url().includes("review-key"), "live site: review link shows the widget and strips the key from the address");

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
