import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp, proxyAwareFetch, type AppHandle } from "../src/server.js";
import { Store } from "../src/db.js";
import type { EnvConfig } from "../src/config.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-server-"));
  mkdirSync(join(dir, "goods"));
  writeFileSync(join(dir, "goods", "guide.md"), "# paid guide");
  writeFileSync(join(dir, "single.md"), "# single");
  const productsPath = join(dir, "products.json");
  writeFileSync(
    productsPath,
    JSON.stringify({
      products: [
        { sku: "guide-dir", title: "Guides", price: "$0.01", route: "GET /goods/*", contentDir: "./goods" },
        { sku: "single", title: "Single", price: "$0.02", route: "GET /files/single.md", contentPath: "./single.md" },
      ],
    }),
  );
  const env: EnvConfig = {
    payTo: "0x1111111111111111111111111111111111111111",
    network: "eip155:84532",
    facilitatorUrl: "https://x402.org/facilitator",
    adminPassword: "test-password-123",
    ipSalt: "salt",
    port: 8402,
    dbPath: ":memory:",
  };
  const store = new Store(":memory:");
  // Stub facilitator: no network in tests. Kinds cover both x402 versions.
  const facilitatorClient = {
    getSupported: async () => ({
      kinds: [1, 2].map((x402Version) => ({ x402Version, network: "eip155:84532", scheme: "exact" })),
    }),
  };
  const handle = createApp({ env, store, baseDir: dir, productsPath, facilitatorClient });
  return { dir, productsPath, store, handle };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("createApp", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(async () => {
    f = fixture();
    await f.handle.init();
  });

  test("free routes: catalog html, catalog json, feed", async () => {
    const html = await f.handle.app.request("/catalog");
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Guides");
    const json = await f.handle.app.request("/catalog.json");
    expect(json.status).toBe(200);
    const feed = await f.handle.app.request("/feed");
    expect(feed.status).toBe(200);
  });

  test("admin requires auth", async () => {
    expect((await f.handle.app.request("/admin")).status).toBe(401);
    const ok = await f.handle.app.request("/admin", {
      headers: { authorization: "Basic " + Buffer.from("admin:test-password-123").toString("base64") },
    });
    expect(ok.status).toBe(200);
  });

  test("paid route without payment → 402 with payment requirements, logged unpaid_402", async () => {
    const res = await f.handle.app.request("/goods/guide.md");
    expect(res.status).toBe(402);
    await flush();
    const rows = f.store.recentRequests(5);
    expect(rows[0]?.outcome).toBe("unpaid_402");
  });

  test("product responses carry no-store so an edge cache can never serve a stale 402", async () => {
    const res = await f.handle.app.request("/goods/guide.md");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // free pages stay cacheable-by-default (no header)
    const catalog = await f.handle.app.request("/catalog");
    expect(catalog.headers.get("cache-control")).toBeNull();
  });

  test("missing file inside paid dir → 404 BEFORE payment challenge", async () => {
    const res = await f.handle.app.request("/goods/nope.md");
    expect(res.status).toBe(404);
  });

  test("dotfile inside paid dir → 404, never 402", async () => {
    writeFileSync(join(f.dir, "goods", ".env"), "SECRET=x");
    const res = await f.handle.app.request("/goods/.env");
    expect(res.status).toBe(404);
  });

  test("products are seeded into the store at boot", () => {
    expect(f.store.productBySku("guide-dir")?.active).toBe(true);
    expect(f.store.productBySku("single")?.active).toBe(true);
  });

  test("reload picks up catalog changes: new product becomes paid, removed product deactivates", async () => {
    writeFileSync(join(f.dir, "extra.md"), "# extra");
    writeFileSync(
      f.productsPath,
      JSON.stringify({
        products: [
          { sku: "extra", title: "Extra", price: "$0.03", route: "GET /files/extra.md", contentPath: "./extra.md" },
        ],
      }),
    );
    f.handle.reload();
    expect((await f.handle.app.request("/files/extra.md")).status).toBe(402);
    // old paid route no longer configured → falls through to not-found
    expect((await f.handle.app.request("/goods/guide.md")).status).toBe(404);
    expect(f.store.productBySku("guide-dir")?.active).toBe(false);
  });

  test("reload with a broken catalog keeps serving the old one", async () => {
    writeFileSync(f.productsPath, "{ not json");
    f.handle.reload();
    expect((await f.handle.app.request("/goods/guide.md")).status).toBe(402);
    expect(f.store.productBySku("guide-dir")?.active).toBe(true);
  });

  test("unknown path → 404 not_found logged", async () => {
    const res = await f.handle.app.request("/nowhere");
    expect(res.status).toBe(404);
    await flush();
    expect(f.store.recentRequests(1)[0]?.outcome).toBe("not_found");
  });
});

describe("root redirect", () => {
  test("the bare domain sends visitors to the store", async () => {
    const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
    const { tmpdir: td } = await import("node:os");
    const { join: j } = await import("node:path");
    const d = mk(j(td(), "x402-root-"));
    wf(j(d, "products.json"), '{"products":[]}');
    const { createApp } = await import("../src/server.js");
    const { Store } = await import("../src/db.js");
    const h = createApp({
      env: { payTo: "0x1111111111111111111111111111111111111111", network: "eip155:84532", facilitatorUrl: "https://x402.org/facilitator", adminPassword: "test-password-123", ipSalt: "s", port: 8402, dbPath: ":memory:" },
      store: new Store(":memory:"), baseDir: d, productsPath: j(d, "products.json"),
      facilitatorClient: { getSupported: async () => ({ kinds: [] }) },
    });
    const res = await h.app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/catalog");
  });
});

describe("behind a TLS-terminating proxy", () => {
  test("x-forwarded-proto: https makes the 402 embed https resource URLs", async () => {
    const f = fixture();
    await f.handle.init();
    const fetchFn = proxyAwareFetch(f.handle.app);
    const res = await fetchFn(
      new Request("http://x402.example.com/goods/guide.md", {
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(402);
    const req = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
    expect(req.resource.url).toMatch(/^https:\/\/x402\.example\.com\//);
  });
});
