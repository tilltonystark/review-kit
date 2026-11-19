/**
 * Plain Node adapter: Express, Fastify (via its raw req/res), or node:http.
 *
 *   import { reviewKitMiddleware } from "./review-kit/node";
 *   app.use("/api/review-kit", reviewKitMiddleware());
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFromEnv, createReviewHandler, type ReviewKitConfig } from "./core";

export function reviewKitMiddleware(config?: ReviewKitConfig) {
  const handler = createReviewHandler(config ?? (() => configFromEnv(process.env)));
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    if (req.method === "POST") {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 4_500_000) {
          res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Too large" }));
          return;
        }
        chunks.push(chunk as Buffer);
      }
    }
    const host = req.headers.host ?? "localhost";
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await handler(
      new Request(`http://${host}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
