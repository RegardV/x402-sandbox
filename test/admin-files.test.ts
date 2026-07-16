import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { adminFiles } from "../src/admin-files.js";
import { Store } from "../src/db.js";
import type { ProductConfig } from "../src/config.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-files-"));
  writeFileSync(join(dir, "existing.md"), "# hello");
  const products: ProductConfig[] = [
    { sku: "lib", title: "Library", price: "$0.01", route: "GET /lib/*", contentDir: dir },
    { sku: "one", title: "One", price: "$0.02", route: "GET /one.md", contentPath: "./one.md" },
  ];
  const store = new Store(":memory:");
  store.syncProducts([{ sku: "lib", title: "Library", price: "$0.01", network: "eip155:84532", contentDir: dir }]);
  const app = new Hono().route("/admin", adminFiles({ products: () => products, store }));
  return { dir, app, store };
}

function upload(name: string, content = "data") {
  const fd = new FormData();
  fd.append("file", new File([content], name));
  return { method: "POST", body: fd };
}

describe("adminFiles", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => (f = fixture()));

  test("lists directory files with delete forms and an upload form", async () => {
    const html = await (await f.app.request("/admin/files/lib")).text();
    expect(html).toContain("existing.md");
    expect(html).toContain('type="file"');
    expect(html).toContain("delete");
  });

  test("upload writes the file into the product directory; catalog pickup is implicit", async () => {
    const res = await f.app.request("/admin/files/lib/upload", upload("new-article.md", "# new"));
    expect(res.status).toBe(302);
    expect(existsSync(join(f.dir, "new-article.md"))).toBe(true);
  });

  test("multi-select: several files upload in one request", async () => {
    const fd = new FormData();
    fd.append("file", new File(["one"], "one.md"));
    fd.append("file", new File(["two"], "two.md"));
    fd.append("file", new File(["three"], "three.csv"));
    const res = await f.app.request("/admin/files/lib/upload", { method: "POST", body: fd });
    expect(res.status).toBe(302);
    for (const name of ["one.md", "two.md", "three.csv"]) {
      expect(existsSync(join(f.dir, name)), name).toBe(true);
    }
  });

  test("multi-select is all-or-nothing: one denied filename rejects the whole batch", async () => {
    const fd = new FormData();
    fd.append("file", new File(["ok"], "fine.md"));
    fd.append("file", new File(["bad"], "secrets.env"));
    const res = await f.app.request("/admin/files/lib/upload", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    expect(existsSync(join(f.dir, "fine.md"))).toBe(false);
    expect(existsSync(join(f.dir, "secrets.env"))).toBe(false);
  });

  test("upload input allows selecting multiple files", async () => {
    const html = await (await f.app.request("/admin/files/lib")).text();
    expect(html).toContain("multiple");
  });

  test("files table shows size, public URL, and per-file paid sales", async () => {
    const pid = f.store.productBySku("lib")!.id;
    for (let i = 0; i < 3; i++) {
      f.store.insertRequest({ ts: new Date().toISOString(), method: "GET", path: "/lib/existing.md", outcome: "paid_200", productId: pid, txHash: `0x${i}` });
    }
    const html = await (await f.app.request("/admin/files/lib")).text();
    expect(html).toContain("7 B"); // "# hello"
    expect(html).toContain("/lib/existing.md"); // the public URL, visible and linkable
    expect(html).toMatch(/>3</); // paid count column
  });

  test("header shows product context: price, revenue, edit link", async () => {
    const pid = f.store.productBySku("lib")!.id;
    f.store.insertSettlement({ ts: new Date().toISOString(), productId: pid, amountUsdc: "0.03", payer: "0xabc", txHash: "0xr", network: "eip155:84532" });
    const html = await (await f.app.request("/admin/files/lib")).text();
    expect(html).toContain("$0.03"); // revenue for this product
    expect(html).toContain("/admin/products/lib/edit");
  });

  test("operator can view a file's content free through the admin (raw)", async () => {
    const res = await f.app.request("/admin/files/lib/raw?path=existing.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# hello");
    expect((await f.app.request("/admin/files/lib/raw?path=../../etc/passwd")).status).toBe(404);
    expect((await f.app.request("/admin/files/lib/raw?path=.env")).status).toBe(404);
  });

  test("upload strips any path components — basename only", async () => {
    await f.app.request("/admin/files/lib/upload", upload("../escape.md"));
    expect(existsSync(join(f.dir, "..", "escape.md"))).toBe(false);
    expect(existsSync(join(f.dir, "escape.md"))).toBe(true);
  });

  test("dotfiles and denied extensions rejected with 400", async () => {
    for (const name of [".env", "backup.env", "server.key", "cert.pem"]) {
      const res = await f.app.request("/admin/files/lib/upload", upload(name));
      expect(res.status).toBe(400);
      expect(existsSync(join(f.dir, name))).toBe(false);
    }
  });

  test("oversized upload rejected", async () => {
    const res = await f.app.request("/admin/files/lib/upload", upload("big.bin", "x".repeat(51 * 1024 * 1024)));
    expect(res.status).toBe(400);
  });

  test("delete removes an existing file; traversal and unknown paths 404", async () => {
    const del = (path: string) =>
      f.app.request("/admin/files/lib/delete", {
        method: "POST",
        body: new URLSearchParams({ path }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    expect((await del("existing.md")).status).toBe(302);
    expect(existsSync(join(f.dir, "existing.md"))).toBe(false);
    expect((await del("../../etc/passwd")).status).toBe(404);
    expect((await del("nope.md")).status).toBe(404);
  });

  test("non-directory products get 404 for file management", async () => {
    expect((await f.app.request("/admin/files/one")).status).toBe(404);
    expect((await f.app.request("/admin/files/unknown")).status).toBe(404);
  });
});
