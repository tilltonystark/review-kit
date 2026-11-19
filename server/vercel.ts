/**
 * Vercel Functions adapter, for any framework on Vercel that is not Next.js
 * (Vite, Astro static, plain HTML...).
 *
 *   // api/review-kit.ts   (served at /api/review-kit)
 *   export { GET, POST, OPTIONS } from "../review-kit/vercel";
 */
import { configFromEnv, createReviewHandler } from "./core";

const handler = createReviewHandler(() => configFromEnv(process.env));

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
