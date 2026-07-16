import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadProducts } from "../src/config.js";
import { paidContent } from "../src/handlers.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/db.js";

const DIR = mkdtempSync(join(tmpdir(), "x402-proxy-"));

describe("proxyUrl config", () => {
  const entry = (extra: object) =>
    JSON.stringify({ products: [{ sku: "p", title: "P", price: "$0.01", route: "GET /ask", ...extra }] });
  test("accepted as the fourth content source", () => {
    const [p] = loadProducts(entry({ proxyUrl: "http://127.0.0.1:9999/ask" }), DIR);
    expect(p!.proxyUrl).toBe("http://127.0.0.1:9999/ask");
  });
  test("mutually exclusive with file sources; must be http(s)", () => {
    expect(() => loadProducts(entry({ proxyUrl: "http://x/y", contentPath: "./a" }), DIR)).toThrow(/exactly one/);
    expect(() => loadProducts(entry({ proxyUrl: "ftp://x/y" }), DIR)).toThrow(/proxyUrl/);
  });
});

describe("proxy delivery", () => {
  let srv: ServerType;
  let port = 0;
  beforeAll(async () => {
    const upstream = new Hono()
      .get("/ask", (c) => c.json({ answer: `you asked: ${c.req.query("q")}` }))
      .post("/search", async (c) => c.json({ echoed: await c.req.json() }))
      .get("/svc/sub/file", (c) => c.json({ ok: true, q: c.req.query("k") }));
    await new Promise<void>((r) => {
      srv = serve({ fetch: upstream.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        port = info.port;
        r();
      });
    });
  });
  afterAll(() => srv.close());

  test("unpaid proxy route still 402s (payment wall applies)", async () => {
    const productsPath = join(DIR, "products-a.json");
    writeFileSync(
      productsPath,
      JSON.stringify({ products: [{ sku: "ask", title: "Ask", price: "$0.01", route: "GET /ask", proxyUrl: `http://127.0.0.1:${port}/ask` }] }),
    );
    const h = createApp({
      env: { payTo: "0x1111111111111111111111111111111111111111", network: "eip155:84532", facilitatorUrl: "https://x402.org/facilitator", adminPassword: "test-password-123", ipSalt: "s", port: 8402, dbPath: ":memory:" },
      store: new Store(":memory:"),
      baseDir: DIR,
      productsPath,
      facilitatorClient: { getSupported: async () => ({ kinds: [{ x402Version: 2, network: "eip155:84532", scheme: "exact" }] }) },
    });
    await h.init();
    expect((await h.app.request("/ask?q=x")).status).toBe(402);
  });

  test("delivery: exact route forwards the query string", async () => {
    const products = loadProducts(
      JSON.stringify({ products: [{ sku: "ask", title: "Ask", price: "$0.01", route: "GET /ask", proxyUrl: `http://127.0.0.1:${port}/ask` }] }),
      DIR,
    );
    const app = new Hono().all("*", paidContent({ store: new Store(":memory:"), products: () => products, baseDir: DIR }));
    const res = await app.request("/ask?q=brix");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: "you asked: brix" });
  });

  test("delivery: wildcard route forwards the subpath and query", async () => {
    const products = loadProducts(
      JSON.stringify({ products: [{ sku: "w", title: "W", price: "$0.01", route: "GET /svc/*", proxyUrl: `http://127.0.0.1:${port}/svc` }] }),
      DIR,
    );
    const app = new Hono().all("*", paidContent({ store: new Store(":memory:"), products: () => products, baseDir: DIR }));
    const res = await app.request("/svc/sub/file?k=v");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, q: "v" });
  });

  test("delivery: POST forwards method, JSON body and content-type", async () => {
    const products = loadProducts(
      JSON.stringify({ products: [{ sku: "s", title: "S", price: "$0.02", route: "POST /search", proxyUrl: `http://127.0.0.1:${port}/search` }] }),
      DIR,
    );
    const app = new Hono().all("*", paidContent({ store: new Store(":memory:"), products: () => products, baseDir: DIR }));
    const res = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "brix", top_k: 3 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: { query: "brix", top_k: 3 } });
  });

  test("unreachable upstream → 502, not a crash", async () => {
    const products = loadProducts(
      JSON.stringify({ products: [{ sku: "d", title: "D", price: "$0.01", route: "GET /dead", proxyUrl: "http://127.0.0.1:1/dead" }] }),
      DIR,
    );
    const app = new Hono().all("*", paidContent({ store: new Store(":memory:"), products: () => products, baseDir: DIR }));
    expect((await app.request("/dead")).status).toBe(502);
  });
});

describe("catalog with proxy products", () => {
  test("proxy products list with their route URL and no size — page must not crash", async () => {
    const { catalogJson, catalogHtml } = await import("../src/handlers.js");
    const products = loadProducts(
      JSON.stringify({ products: [{ sku: "ask", title: "Ask", price: "$0.02", route: "POST /ask", proxyUrl: "http://127.0.0.1:9/x" }] }),
      DIR,
    );
    const deps = { store: new Store(":memory:"), products: () => products, baseDir: DIR };
    const app = new Hono().get("/catalog.json", catalogJson(deps)).get("/catalog", catalogHtml(deps));
    const json = (await (await app.request("/catalog.json")).json()) as { products: Array<{ sku: string; url?: string; size?: number }> };
    expect(json.products[0]).toMatchObject({ sku: "ask", url: "/ask" });
    expect(json.products[0]!.size).toBeUndefined();
    expect((await app.request("/catalog")).status).toBe(200);
  });
});
