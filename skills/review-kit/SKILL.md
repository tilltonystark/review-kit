---
name: review-kit
description: Install Review Kit (click-to-comment on any website, comments land on GitHub) on a site, work through the review comments it collects, or maintain it (reviewers, token, staging). Use when someone says install/set up Review Kit, "check the review inbox", "pick up the review comments", or wants to add/remove a reviewer or renew the token.
---

# Review Kit

Review Kit lets people click any element on a website, write what should change, and send it to GitHub. You (Claude) then fix each comment on a branch and open a pull request.

Pieces (all in https://github.com/tilltonystark/review-kit):

| Piece | Path in the kit repo | Goes to the site as |
| --- | --- | --- |
| Widget (browser) | `dist/widget/*` (all files) | `<public folder>/review-kit/` + one `<script>` tag |
| Server handler | `server/core.ts` + one host file | `review-kit/` folder in the site's source |
| Relay (static sites) | `relay/` | A Cloudflare Worker the user deploys once |
| Optional Actions | `github/workflows/*` | `.github/workflows/` |

Pick the job: **Install** (below), **Work the inbox** (`references/inbox.md`), **Maintain** (`references/maintain.md`). Host-specific steps are in `references/hosts.md`; read only the section for this site's host. Security rules are in `references/security.md`; follow them in every job.

## Install

Goal: the site shows the widget to reviewers, a test comment lands on GitHub, and the user knows how to use it. Work on a branch and open a pull request; never commit to the default branch.

### 1. Find out what you are working with (read, don't ask)

- **Repo**: `git remote get-url origin`. Must be on GitHub. If the site's code is not in a GitHub repo (Webflow, Wix, hosted WordPress), say Review Kit can still collect comments into a GitHub repo of their choice, but you can only fix code you can reach; ask whether to go on.
- **Framework**: from `package.json` / files: Next.js (App or Pages router), Astro, SvelteKit, Nuxt, Vite/React, plain HTML, Hugo/Jekyll, other.
- **Host**: `vercel.json` or `.vercel/` → Vercel; `netlify.toml` → Netlify; `wrangler.toml` / `functions/` for Pages → Cloudflare; `.github/workflows/*pages*` or a `gh-pages` branch → GitHub Pages; Dockerfile/Express server → own server. If unclear, ask.
- **Server code possible?** Yes for Next.js, SvelteKit, Nuxt, Astro with an adapter, any Vercel/Netlify/Cloudflare site (functions), own Node server. No for GitHub Pages, S3 and other pure static hosts → use the relay.
- **Previews/staging**: does the host build a preview per branch or PR? Is there a `staging` branch?
- **CSP**: grep for `Content-Security-Policy` (headers config, middleware, meta tags).

### 2. Ask the user three things (one message, defaults included)

1. "Should it work on the **live site** too (hidden, only for people with a review link), or **only on previews**?" Default: both if the host has previews, live only if not.
2. "Who will review? I'll make each person their own private link." Default: just them.
3. "Do you want **screenshots** in comments?" Default: yes. If the repo is **public**, say screenshots will be publicly visible on GitHub and default to no.

### 3. Add the files

Copy from the latest kit release tag (fall back to `main`). Pin the version in a comment at the top of each copied file, e.g. `// review-kit v0.1.0`.

1. **Widget**: copy every file in `dist/widget/` to `<public folder>/review-kit/` (`public/` for Next/Vite/Astro/SvelteKit `static/`, the site root for plain HTML). Keep file names; the chunks load each other by relative path.
2. **Script tag**, before `</body>` on every page (in the root layout / base template):
   ```html
   <script type="module" src="/review-kit/review-kit.js"
           data-endpoint="/api/review-kit"
           data-require-key="LIVE"></script>
   ```
   - `LIVE` = `"true"` when the tag is on the live site. For "previews only", render the tag only when the host says it is a preview (Next.js: `process.env.VERCEL_ENV === "preview"` in the server layout; Netlify: `CONTEXT !== "production"`; otherwise use a build variable) and use `"false"`.
   - Relay: `data-endpoint="https://<relay>.workers.dev"` and always `data-require-key="true"`.
   - `data-screenshots="false"` if they said no to screenshots.
3. **Server handler** (skip for relay): copy `server/core.ts` and the host file from `references/hosts.md` into `review-kit/` in the source (`src/review-kit/` if the project uses `src/`), then add the route file that section shows. If the project is plain JavaScript, copy the matching file from `dist/server/` instead.
4. **CSP**: if there is one, make sure `script-src` allows `'self'` and `connect-src` allows the endpoint (relay URL if used), and `img-src` allows `data:` (screenshots are drawn from data URLs).
5. **Ignore screenshots branch in deploys** (Vercel): add `"git": {"deploymentEnabled": {"review-assets": false}}` to `vercel.json`. Netlify: tell the user to set "Branch deploys: none" or skip; the branch has no site in it so a build fails harmlessly.

### 4. Secrets (the user does this; you guide)

Read `references/security.md` first. Then:

1. Make **reviewer keys**: for each reviewer, generate `k_` + 24 random URL-safe characters (`node -e "console.log('k_'+require('crypto').randomBytes(18).toString('base64url'))"`). Build `REVIEW_KIT_REVIEWERS="Name:key, Name2:key2"`. Show the value to the user once in chat; never write it to a file in the repo.
2. Walk them through the **GitHub token** exactly as in `docs/GETTING-STARTED.md` step 4 (fine-grained, only this repo, Issues + Pull requests + Contents read/write). Link: https://github.com/settings/personal-access-tokens/new
3. Walk them through adding `REVIEW_KIT_GITHUB_TOKEN` and `REVIEW_KIT_REVIEWERS` on the host (section in `references/hosts.md`), marked secret/sensitive, for the environments they chose, then **redeploy**.
4. If the host does not expose the repo name to functions, also set `REVIEW_KIT_REPO=owner/name`.

Never ask the user to paste the GitHub token into the chat. If they do anyway, don't repeat it, tell them to revoke it and make a new one, and continue.

### 5. Check it works

1. Open the PR; wait for its preview (or, live-only, ask the user to merge and deploy).
2. Open `<site>/api/review-kit` (or the relay URL) with header `X-Review-Key: <a key>`: `ready: true` means done. Otherwise fix what `problem` says (the table in `docs/GETTING-STARTED.md` → Troubleshooting maps every message to a fix).
3. Give each reviewer their link: `<site>/?review-key=<their key>`. Opening it once stores the key in that browser and removes it from the address bar. `?review-key=off` hides the widget again.
4. Ask the user to leave one test comment, then confirm you can see it on GitHub.

### 6. Hand over

Tell the user, in plain words: how to comment (Comment button or `C`, click, write, Send; Parent widens the selection), where comments go (the branch's PR, or the "Site review: <branch>" issue), and that they can say **"check the review inbox"** any time. Offer the optional extras in one line each:

- **Staging that mirrors live** (`github/workflows/sync-staging.yml`): for hosts with branch previews, so they can review the live site without touching it.
- **Auto-pickup** (`github/workflows/review-kit-claude.yml`): Claude starts on each new comment by itself; needs an Anthropic API key in GitHub secrets and uses API credits.

Add a short `REVIEW_KIT.md` to the site repo with the links, where the files are, and how to turn it off (`REVIEW_KIT_DISABLED=1`).

## Edge cases to handle, not ask about

- No staging and no previews: comments from the live site go to "Site review: production". Fixes still go through a PR; the user checks after merging.
- Branch has no open PR: the handler posts to "Site review: <branch>" by itself.
- Single-page apps: nothing to do; the widget reads the page at send time.
- Several sites, one relay: add each site's origin to `REVIEW_KIT_SITES`; one token with all repos selected.
- Monorepo: put files in the site's package, not the root.
- Existing easygermanguide-style "review mode" in the repo: replace it, keep `GITHUB_REVIEW_TOKEN` working (the handler reads it as a fallback), and move its docs to `REVIEW_KIT.md`.
