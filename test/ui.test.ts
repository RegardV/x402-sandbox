import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { catalogHtml, feedPage, type HandlerDeps } from "../src/handlers.js";
import { adminApp } from "../src/admin.js";
import { Store } from "../src/db.js";
import type { ProductConfig } from "../src/config.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-ui-"));
  writeFileSync(join(dir, "guide.md"), "x".repeat(2048)); // 2.0 KB
  const products: ProductConfig[] = [
    { sku: "lib", title: "Library", price: "$0.01", route: "GET /lib/*", contentDir: dir },
  ];
  const store = new Store(":memory:");
  store.syncProducts([{ sku: "lib", title: "Library", price: "$0.01", network: "eip155:84532", contentDir: dir }]);
  const deps: HandlerDeps = { store, products: () => products, baseDir: dir };
  const app = new Hono();
  app.get("/catalog", catalogHtml(deps));
  app.get("/feed", feedPage(deps));
  return { app, store, dir };
}

describe("catalog UI", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => (f = fixture()));

  test("has nav linking to the feed", async () => {
    const html = await (await f.app.request("/catalog")).text();
    expect(html).toContain('href="/feed"');
  });

  test("shows file sizes for directory products", async () => {
    const html = await (await f.app.request("/catalog")).text();
    expect(html).toContain("2.0 KB");
  });

  test("file rows link to the paid URL", async () => {
    const html = await (await f.app.request("/catalog")).text();
    expect(html).toContain('href="/lib/guide.md"');
  });
});

describe("content preview cards", () => {
  test("preview:true products show a text excerpt so buyers/agents see what the content is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-prev-"));
    writeFileSync(join(dir, "intro.md"), "# Soil Regeneration Basics\nCompost ratios for smallholders." + "x".repeat(500));
    const products: ProductConfig[] = [
      { sku: "p", title: "Previews", price: "$0.01", route: "GET /p/*", contentDir: dir, preview: true },
    ];
    const store = new Store(":memory:");
    const deps: HandlerDeps = { store, products: () => products, baseDir: dir };
    const app = new Hono();
    app.get("/catalog", catalogHtml(deps));
    app.get("/catalog.json", (await import("../src/handlers.js")).catalogJson(deps));

    const html = await (await app.request("/catalog")).text();
    expect(html).toContain("Soil Regeneration Basics");
    expect(html).not.toContain("x".repeat(400)); // excerpt is capped, not the whole file

    const json = (await (await app.request("/catalog.json")).json()) as any;
    expect(json.products[0].files[0].excerpt).toContain("Soil Regeneration Basics");
  });

  test("without preview flag no file content leaks into the catalog", async () => {
    const html = await (await fixture().app.request("/catalog")).text();
    expect(html).not.toContain("xxxxxxxxxx");
  });
});

describe("feed UI", () => {
  test("has nav linking back to the catalog and shows the sale", async () => {
    const f = fixture();
    f.store.insertSettlement({
      ts: new Date().toISOString(),
      productId: f.store.productBySku("lib")!.id,
      amountUsdc: "0.01",
      payer: "0xD850dbf9618E92BD41B0Cd110E0769B0e0441C7C",
      txHash: "0xabc",
      network: "eip155:84532",
    });
    const html = await (await f.app.request("/feed")).text();
    expect(html).toContain('href="/catalog"');
    expect(html).toContain("Library");
    expect(html).toContain("0xD850…1C7C");
  });
});

describe("admin UI", () => {
  test("links to feed and catalog", async () => {
    const store = new Store(":memory:");
    const app = new Hono();
    app.route("/admin", adminApp(store, "test-password-123", "eip155:84532"));
    const res = await app.request("/admin", {
      headers: { authorization: "Basic " + Buffer.from("admin:test-password-123").toString("base64") },
    });
    const html = await res.text();
    expect(html).toContain('href="/feed"');
    expect(html).toContain('href="/catalog"');
    expect(html).toContain('href="/admin/settings"'); // the gear
    expect(html).toContain('href="/admin/products/new"');
    expect(html).toContain('href="/admin/export/sales.csv"');
  });

  test("each product row has a remove control posting to the delete route", async () => {
    const store = new Store(":memory:");
    store.syncProducts([{ sku: "lib", title: "Library", price: "$0.01", network: "eip155:84532", contentDir: "/x" }]);
    const app = new Hono();
    app.route("/admin", adminApp(store, "test-password-123", "eip155:84532"));
    const res = await app.request("/admin", {
      headers: { authorization: "Basic " + Buffer.from("admin:test-password-123").toString("base64") },
    });
    const html = await res.text();
    expect(html).toContain('action="/admin/products/lib/delete"');
    expect(html).toMatch(/confirm\(/);
  });
});
