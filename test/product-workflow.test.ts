import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { adminCrud } from "../src/admin-crud.js";
import { Store } from "../src/db.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-flow-"));
  mkdirSync(join(dir, "content"));
  const productsPath = join(dir, "products.json");
  writeFileSync(productsPath, '{"products":[]}');
  let reloads = 0;
  const app = new Hono().route(
    "/admin",
    adminCrud({ store: new Store(":memory:"), productsPath, baseDir: dir, onCatalogChange: () => reloads++ }),
  );
  const catalog = () => JSON.parse(readFileSync(productsPath, "utf8")).products;
  return { dir, app, catalog, reloads: () => reloads };
}

function form(fields: Record<string, string>, file?: { name: string; content: string }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("file", new File([file.content], file.name));
  return { method: "POST", body: fd };
}

describe("add-product workflow (simple mode)", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => (f = fixture()));

  test("form offers the simple fields: type choice, title, price", async () => {
    const html = await (await f.app.request("/admin/products/new")).text();
    expect(html).toContain('name="type"');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="price"');
  });

  test("folder product: derives sku/route, creates the directory, redirects to its files page", async () => {
    const res = await f.app.request("/admin/products", form({ type: "folder", title: "Soil Guides", price: "0.05" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/files/soil-guides");
    const [p] = f.catalog();
    expect(p).toMatchObject({
      sku: "soil-guides",
      title: "Soil Guides",
      price: "$0.05",
      route: "GET /soil-guides/*",
      contentDir: "./content/soil-guides",
    });
    expect(existsSync(join(f.dir, "content", "soil-guides"))).toBe(true);
    expect(f.reloads()).toBe(1);
  });

  test("file product: uploads the file and derives contentPath + exact route", async () => {
    const res = await f.app.request(
      "/admin/products",
      form({ type: "file", title: "The Guide", price: "$0.10" }, { name: "guide.pdf", content: "pdfdata" }),
    );
    expect(res.status).toBe(302);
    const [p] = f.catalog();
    expect(p).toMatchObject({
      sku: "the-guide",
      price: "$0.10",
      route: "GET /the-guide/guide.pdf",
      contentPath: "./content/the-guide/guide.pdf",
    });
    expect(readFileSync(join(f.dir, "content", "the-guide", "guide.pdf"), "utf8")).toBe("pdfdata");
  });

  test("file product without an upload → 400", async () => {
    const res = await f.app.request("/admin/products", form({ type: "file", title: "No File", price: "0.01" }));
    expect(res.status).toBe(400);
    expect(f.catalog()).toHaveLength(0);
  });

  test("duplicate title/sku → 400 with the validator error shown", async () => {
    await f.app.request("/admin/products", form({ type: "folder", title: "Dup", price: "0.01" }));
    const res = await f.app.request("/admin/products", form({ type: "folder", title: "Dup", price: "0.01" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("dup");
    expect(f.catalog()).toHaveLength(1);
  });

  test("reserved names are rejected", async () => {
    const res = await f.app.request("/admin/products", form({ type: "folder", title: "Admin", price: "0.01" }));
    expect(res.status).toBe(400);
  });

  test("advanced mode (explicit route) still works", async () => {
    writeFileSync(join(f.dir, "raw.md"), "x");
    const res = await f.app.request(
      "/admin/products",
      form({ sku: "raw", title: "Raw", price: "$0.02", route: "GET /raw.md", contentPath: "./raw.md" }),
    );
    expect(res.status).toBe(302);
    expect(f.catalog()[0].route).toBe("GET /raw.md");
  });
});
