import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { docsRoutes } from "../src/docs.js";

const app = new Hono().route("/", docsRoutes());

describe("docs", () => {
  test("index renders with the section nav", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const t of ["402 Payment Required", "products.json", "Networks", "Security model", "HTTP reference"]) {
      expect(html).toContain(t);
    }
  });

  test("every section page renders and is free of auth", async () => {
    for (const slug of ["products", "buying", "admin", "networks", "security", "api"]) {
      const res = await app.request(`/docs/${slug}`);
      expect(res.status, slug).toBe(200);
    }
  });

  test("unknown page 404s", async () => {
    expect((await app.request("/docs/nope")).status).toBe(404);
  });

  test("docs content matches the real wire facts", async () => {
    const api = await (await app.request("/docs/api")).text();
    expect(api).toContain("PAYMENT-RESPONSE");
    expect(api).toContain("eip155:84532");
    const buying = await (await app.request("/docs/buying")).text();
    expect(buying).toContain("wrapFetchWithPayment");
  });
});
