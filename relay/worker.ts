/**
 * Review Kit relay: a Cloudflare Worker for sites that have no server of
 * their own (GitHub Pages, S3, any static host). Deploy it once; it serves all
 * your sites. The GitHub token lives here as a Worker secret.
 *
 * Variables (Workers -> your relay -> Settings -> Variables and Secrets):
 *   REVIEW_KIT_GITHUB_TOKEN  Secret. Fine-grained token with every site repo selected.
 *   REVIEW_KIT_REVIEWERS     Secret. "Om:k_..., Satyam:k_..."
 *   REVIEW_KIT_SITES         JSON: which site goes to which repo, e.g.
 *     {"https://example.com": {"repo": "me/site"},
 *      "https://me.github.io": {"repo": "me/blog", "branch": "main"}}
 *
 * In each site's script tag: data-endpoint="https://<relay>.workers.dev"
 * and data-require-key="true".
 */
import { createReviewHandler, cleanToken, parseReviewers, type ReviewKitConfig } from "../server/core";

type Env = Record<string, string | undefined>;
type Site = { repo: string; branch?: string; environment?: ReviewKitConfig["environment"]; screenshots?: boolean };

function sites(env: Env): Record<string, Site> {
  try {
    const raw = JSON.parse(env.REVIEW_KIT_SITES ?? "{}") as Record<string, Site>;
    const out: Record<string, Site> = {};
    for (const [origin, site] of Object.entries(raw)) if (site?.repo) out[origin.replace(/\/$/, "")] = site;
    return out;
  } catch {
    return {};
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const all = sites(env);
    const origin = request.headers.get("origin")?.replace(/\/$/, "") ?? "";
    const site = all[origin];
    const handler = createReviewHandler({
      token: cleanToken(env.REVIEW_KIT_GITHUB_TOKEN),
      repo: site?.repo,
      branch: site?.branch ?? "production",
      environment: site?.environment ?? "production",
      reviewers: parseReviewers(env.REVIEW_KIT_REVIEWERS),
      allowedOrigins: Object.keys(all),
      screenshots: site?.screenshots,
      rateLimitPerHour: Number(env.REVIEW_KIT_RATE_LIMIT) || undefined,
    });
    if (!site && request.method !== "OPTIONS") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "This site is not set up on the Review Kit relay. Add it to REVIEW_KIT_SITES." }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return handler(request);
  },
};
