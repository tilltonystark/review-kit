/**
 * Cloudflare Pages Functions adapter.
 *
 *   // functions/api/review-kit.ts   (served at /api/review-kit)
 *   export { onRequest } from "../../review-kit/cloudflare";
 *
 * Set the variables in Pages -> Settings -> Variables and Secrets.
 * The token must be added as a Secret, for Preview and/or Production.
 */
import { configFromEnv, createReviewHandler } from "./core";

type Context = { request: Request; env: Record<string, unknown> };

export const onRequest = (context: Context) => {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(context.env)) if (typeof v === "string") env[k] = v;
  return createReviewHandler(configFromEnv(env))(context.request);
};
