# Host-specific steps

Read only the section for the site's host. Every section: which kit file to copy next to `core.ts`, the route file to add, and where the user sets the secrets. After setting variables, the user must **redeploy**: running deployments never see new variables.

## Next.js (any host, App Router)

- Copy `server/core.ts` + `server/next.ts` → `src/review-kit/` (or `review-kit/`).
- Route file `app/api/review-kit/route.ts`:
  ```ts
  export { GET, POST, OPTIONS } from "@/review-kit/next"; // adjust the import path
  export const dynamic = "force-dynamic";
  ```
  If `next.config` has `cacheComponents: true` (Next 16+), leave out the `dynamic` line: the build refuses it, and the route is dynamic anyway because it reads the request.
- Pages Router only: add `pages/api/review-kit.ts` using `server/node.ts`: `export default reviewKitMiddleware(); export const config = { api: { bodyParser: false } };`
- Script tag in `app/layout.tsx` with `next/script` is fine, but a plain `<script type="module">` in the body works and is simpler.
- Then the host section below for secrets.

## Vercel

- Next.js: section above. Other frameworks: copy `server/core.ts` + `server/vercel.ts`, add `api/review-kit.ts`: `export { GET, POST, OPTIONS } from "../review-kit/vercel";`
- Vercel sets repo, branch, commit, PR and environment for you (`VERCEL_*`). Make sure **System Environment Variables** are exposed (default on).
- Secrets: Project → Settings → Environment Variables → add `REVIEW_KIT_GITHUB_TOKEN` and `REVIEW_KIT_REVIEWERS`, tick **Sensitive**, choose **Production** and/or **Preview** to match what they picked. Redeploy (Deployments → ⋯ → Redeploy).
- Previews are private by default (Deployment Protection → Vercel Authentication). If they are, the user may set `REVIEW_KIT_REQUIRE_KEY=0` for **Preview** only, so teammates don't need links there.
- Add to `vercel.json`: `{"git": {"deploymentEnabled": {"review-assets": false}}}`.

## Netlify

- Copy `server/core.ts` + `server/netlify.ts`, add `netlify/functions/review-kit.ts`: `export { default, config } from "../../review-kit/netlify";` (the `config` serves it at `/api/review-kit`).
- Netlify sets `CONTEXT`, `HEAD`, `COMMIT_REF`, `REVIEW_ID`, `REPOSITORY_URL` at build time; functions may not see them at runtime. Add to `netlify.toml` so they do:
  ```toml
  [build.environment]
    REVIEW_KIT_REPO = "owner/name"
  ```
  and set `REVIEW_KIT_ENV` per context: `[context.production.environment] REVIEW_KIT_ENV = "production"`, `[context.deploy-preview.environment] REVIEW_KIT_ENV = "preview"`, `[context.branch-deploy.environment] REVIEW_KIT_ENV = "preview"`.
- **Deploy previews on Netlify are public by default.** Keep keys required on previews (do not set `REVIEW_KIT_REQUIRE_KEY=0`) unless the team has password protection on.
- Secrets: Site configuration → Environment variables → add both, mark **Contains secret values**, scope **Functions**, choose the deploy contexts. Redeploy.

## Cloudflare Pages

- Copy `server/core.ts` + `server/cloudflare.ts`, add `functions/api/review-kit.ts`: `export { onRequest } from "../../review-kit/cloudflare";`
- Cloudflare sets `CF_PAGES_BRANCH`, `CF_PAGES_COMMIT_SHA`, `CF_PAGES_URL`. Set `REVIEW_KIT_REPO=owner/name` and `REVIEW_KIT_PRODUCTION_BRANCH` if it is not `main`.
- Secrets: Workers & Pages → the project → Settings → Variables and Secrets → add as **Secret**, for Production and Preview. Redeploy.
- Preview URLs (`*.pages.dev`) are public unless Cloudflare Access is on: keep keys required.

## Own Node server (Express, Fastify, Koa, plain http)

- Copy `server/core.ts` + `server/node.ts`. Mount before any body parser:
  ```js
  app.use("/api/review-kit", reviewKitMiddleware());
  ```
- Set the variables in the server's environment (`.env` that is git-ignored, or the platform's secret store). Set `REVIEW_KIT_REPO`, `REVIEW_KIT_ENV=production` on the live server, `REVIEW_KIT_BRANCH` if known.
- Render: sets `RENDER_GIT_BRANCH`, `RENDER_GIT_REPO_SLUG`; Railway/Fly: set `REVIEW_KIT_REPO` and `REVIEW_KIT_ENV` yourself.

## Other frameworks with server routes (Astro SSR, SvelteKit, Nuxt, Remix, Hono)

`createReviewHandler(configFromEnv(env))` takes a `Request` and returns a `Response`. Wire it into the framework's endpoint, e.g. SvelteKit `src/routes/api/review-kit/+server.ts`:
```ts
import { configFromEnv, createReviewHandler } from "$lib/review-kit/core";
import { env } from "$env/dynamic/private";
const handle = createReviewHandler(() => configFromEnv(env));
export const GET = ({ request }) => handle(request);
export const POST = ({ request }) => handle(request);
```
Astro: `export const prerender = false;` and `export const ALL = ({ request }) => handle(request);` in `src/pages/api/review-kit.ts`.

## Static only (GitHub Pages, S3, Hugo/Jekyll with no functions): the relay

1. The user needs a free Cloudflare account. In the kit repo's `relay/` folder: `npx wrangler login`, edit `REVIEW_KIT_SITES` in `wrangler.toml` (site origin → repo), `npx wrangler deploy`.
2. `npx wrangler secret put REVIEW_KIT_GITHUB_TOKEN`, then `npx wrangler secret put REVIEW_KIT_REVIEWERS`.
3. Script tag: `data-endpoint="https://review-kit-relay.<account>.workers.dev"` and `data-require-key="true"`.
4. A new site later: add its origin to `REVIEW_KIT_SITES`, add its repo to the token, deploy again.
