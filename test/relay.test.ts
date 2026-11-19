import { describe, expect, it } from "vitest";
import relay from "../relay/worker";

const env = {
  REVIEW_KIT_GITHUB_TOKEN: "github_pat_x",
  REVIEW_KIT_REVIEWERS: "Om:k_12345678",
  REVIEW_KIT_SITES: JSON.stringify({ "https://good.test": { repo: "me/site" } }),
};

describe("relay", () => {
  it("rejects sites that are not listed", async () => {
    const res = await relay.fetch(new Request("https://relay.test/", { method: "POST", headers: { Origin: "https://evil.test" }, body: "{}" }), env);
    expect(res.status).toBe(403);
  });
  it("answers the preflight for a listed site", async () => {
    const res = await relay.fetch(new Request("https://relay.test/", { method: "OPTIONS", headers: { Origin: "https://good.test" } }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Review-Key");
  });
  it("needs a reviewer key (relayed sites are live sites)", async () => {
    const res = await relay.fetch(
      new Request("https://relay.test/", { method: "POST", headers: { Origin: "https://good.test", "Content-Type": "application/json" }, body: JSON.stringify({ comment: "x", element: {} }) }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
