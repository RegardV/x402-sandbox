import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp, type AppHandle } from "../src/server.js";
import { Store } from "../src/db.js";
import type { EnvConfig } from "../src/config.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-server-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "guide.md"), "# paid guide");
  writeFileSync(join(dir, "single.md"), "# single");
  const productsPath = join(dir, "products.json");
  writeFileSync(
    productsPath,
    JSON.stringify({
      products: [
        { sku: "guide-dir", title: "Guides", price: "$0.01", route: "GET /docs/*", contentDir: "./docs" },
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
    const res = await f.handle.app.request("/docs/guide.md");
    expect(res.status).toBe(402);
    await flush();
    const rows = f.store.recentRequests(5);
    expect(rows[0]?.outcome).toBe("unpaid_402");
  });

  test("missing file inside paid dir → 404 BEFORE payment challenge", async () => {
    const res = await f.handle.app.request("/docs/nope.md");
    expect(res.status).toBe(404);
  });

  test("dotfile inside paid dir → 404, never 402", async () => {
    writeFileSync(join(f.dir, "docs", ".env"), "SECRET=x");
    const res = await f.handle.app.request("/docs/.env");
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
    expect((await f.handle.app.request("/docs/guide.md")).status).toBe(404);
    expect(f.store.productBySku("guide-dir")?.active).toBe(false);
  });

  test("reload with a broken catalog keeps serving the old one", async () => {
    writeFileSync(f.productsPath, "{ not json");
    f.handle.reload();
    expect((await f.handle.app.request("/docs/guide.md")).status).toBe(402);
    expect(f.store.productBySku("guide-dir")?.active).toBe(true);
  });

  test("unknown path → 404 not_found logged", async () => {
    const res = await f.handle.app.request("/nowhere");
    expect(res.status).toBe(404);
    await flush();
    expect(f.store.recentRequests(1)[0]?.outcome).toBe("not_found");
  });
});
