/**
 * Netlify Functions adapter.
 *
 *   // netlify/functions/review-kit.ts
 *   export { default, config } from "../../review-kit/netlify";
 *
 * Netlify only gives functions the build variables (CONTEXT, HEAD, REVIEW_ID...)
 * when they are set at build time, so the skill also adds them to
 * netlify.toml. REVIEW_KIT_* variables always win.
 */
import { configFromEnv, createReviewHandler } from "./core";

declare const Netlify: { env: { toObject(): Record<string, string> } } | undefined;

const handler = createReviewHandler(() =>
  configFromEnv(typeof Netlify !== "undefined" ? Netlify.env.toObject() : (process.env as Record<string, string | undefined>)),
);

export default handler;
export const config = { path: "/api/review-kit" };
