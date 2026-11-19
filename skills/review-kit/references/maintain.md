# Maintain Review Kit

## Add a reviewer
Generate a key (`k_` + 24 url-safe random chars), append `, Name:key` to `REVIEW_KIT_REVIEWERS` on the host (or `wrangler secret put` for the relay), redeploy, send them `<site>/?review-key=<key>`.

## Remove a reviewer
Delete their `Name:key` pair from `REVIEW_KIT_REVIEWERS`, redeploy. Their link stops working at once.

## Renew the GitHub token
The widget and the setup check warn 14 days before expiry. Make a new token (same settings), replace `REVIEW_KIT_GITHUB_TOKEN` on the host, redeploy, then delete the old token on GitHub. Comments that failed meanwhile are kept in the reviewer's browser and can be resent.

## Add staging that mirrors the live site
Copy `github/workflows/sync-staging.yml` to `.github/workflows/`. It force-pushes the default branch to `staging` after every merge. On Vercel/Netlify/Cloudflare the `staging` branch then gets a preview with the widget; optional nicer address: add `staging.<domain>` for branch `staging` in the host's domain settings. Comments there go to "Site review: staging". Never commit to `staging`.

## Turn on auto-pickup
Copy `github/workflows/review-kit-claude.yml`. The user adds `ANTHROPIC_API_KEY` in GitHub → Settings → Secrets and variables → Actions, and installs the Claude GitHub app (https://github.com/apps/claude). Each new Review Kit comment then starts a Claude run that follows `references/inbox.md`. Uses API credits; say so.

## Update the kit
Compare the version comment in the copied files with the latest kit release. Replace `review-kit/` widget files and `core.ts` + host file; read the release notes for new variables.

## Turn it off / uninstall
Quick off: set `REVIEW_KIT_DISABLED=1` and redeploy (endpoint answers 404, widget shows a "switched off" note to reviewers only). Uninstall: remove the script tag, the `review-kit/` folders, the route file, the variables, and optionally the `review-assets` branch and the `review-kit` label.
