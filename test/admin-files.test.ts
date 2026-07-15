import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { adminFiles } from "../src/admin-files.js";
import type { ProductConfig } from "../src/config.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-files-"));
  writeFileSync(join(dir, "existing.md"), "# hello");
  const products: ProductConfig[] = [
    { sku: "lib", title: "Library", price: "$0.01", route: "GET /lib/*", contentDir: dir },
    { sku: "one", title: "One", price: "$0.02", route: "GET /one.md", contentPath: "./one.md" },
  ];
  const app = new Hono().route("/admin", adminFiles({ products: () => products }));
  return { dir, app };
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
