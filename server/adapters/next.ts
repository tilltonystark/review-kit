/**
 * Next.js (App Router) adapter.
 *
 *   // app/api/review-kit/route.ts
 *   export { GET, POST, OPTIONS, dynamic } from "./review-kit"; // file copied by the skill
 */
import { configFromEnv, createReviewHandler } from "../core";

const handler = createReviewHandler(() => configFromEnv(process.env));

export const dynamic = "force-dynamic";
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
