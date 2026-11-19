/**
 * Next.js (App Router) adapter.
 *
 *   // app/api/review-kit/route.ts
 *   export { GET, POST, OPTIONS } from "@/review-kit/next";
 *   export const dynamic = "force-dynamic"; // Next needs this written in the route file itself
 */
import { configFromEnv, createReviewHandler } from "./core";

const handler = createReviewHandler(() => configFromEnv(process.env));

export const dynamic = "force-dynamic";
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
