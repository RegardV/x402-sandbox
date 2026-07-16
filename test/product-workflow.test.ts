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

function folderForm(fields: Record<string, string>, files: Array<{ name: string; content: string }>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ type: "folder", ...fields })) fd.append(k, v);
  for (const f of files) fd.append("files", new File([f.content], f.name));
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

  test("form separates folder vs file into distinct sections that toggle with the choice", async () => {
    const html = await (await f.app.request("/admin/products/new")).text();
    expect(html).toContain('id="file-fields"'); // file upload lives in its own section…
    expect(html).toContain('id="folder-fields"'); // …folder flow has its own too…
    expect(html).toContain('id="fixed-fields"');
    expect(html).toContain('id="demand-fields"'); // …and pricing fields split by mode
    expect(html).toMatch(/type-toggle|addEventListener/); // toggled live, not all shown at once
  });

  test("preview tick lives only in the folder flow (it is a no-op for single files)", async () => {
    const html = await (await f.app.request("/admin/products/new")).text();
    const folderSection = html.slice(html.indexOf('id="folder-fields"'), html.indexOf('id="file-fields"') > html.indexOf('id="folder-fields"') ? html.indexOf('id="file-fields"') : undefined);
    const folderBlock = html.slice(html.indexOf('id="folder-fields"'));
    expect(folderBlock.slice(0, folderBlock.indexOf("</div>") + 6 + 2000).includes('name="preview"') || folderSection.includes('name="preview"')).toBe(true);
    // exactly one preview input on the page, and it sits inside the folder section
    expect(html.split('name="preview"').length - 1).toBe(1);
    expect(html.indexOf('name="preview"')).toBeGreaterThan(html.indexOf('id="folder-fields"'));
  });

  test("folder flow: files selected at creation land in the new folder, listed and sellable", async () => {
    const res = await f.app.request(
      "/admin/products",
      folderForm({ title: "Field Notes", price: "0.02" }, [
        { name: "one.md", content: "# one" },
        { name: "two.pdf", content: "pdfbytes" },
      ]),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/files/field-notes");
    expect(readFileSync(join(f.dir, "content", "field-notes", "one.md"), "utf8")).toBe("# one");
    expect(existsSync(join(f.dir, "content", "field-notes", "two.pdf"))).toBe(true);
  });

  test("folder flow: a denied filename in the selection rejects the whole creation — no product, no files", async () => {
    const res = await f.app.request(
      "/admin/products",
      folderForm({ title: "Poisoned", price: "0.02" }, [
        { name: "ok.md", content: "x" },
        { name: "backup.env", content: "SECRET" },
      ]),
    );
    expect(res.status).toBe(400);
    expect(f.catalog()).toHaveLength(0);
    expect(existsSync(join(f.dir, "content", "poisoned"))).toBe(false);
  });

  test("folder flow without files still works (add later on the files page)", async () => {
    const res = await f.app.request("/admin/products", folderForm({ title: "Empty Start", price: "0.01" }, []));
    expect(res.status).toBe(302);
    expect(f.catalog()[0].sku).toBe("empty-start");
  });

  test("editing a product can toggle Bazaar discoverability on and off after creation", async () => {
    await f.app.request("/admin/products", form({ type: "folder", title: "Late Reg", price: "0.01" }));
    // edit form offers the checkbox
    const editHtml = await (await f.app.request("/admin/products/late-reg/edit")).text();
    expect(editHtml).toContain('name="discoverable"');
    // turn it ON via edit
    await f.app.request(
      "/admin/products/late-reg",
      form({ title: "Late Reg", price: "$0.01", discoverable: "on" }),
    );
    expect(f.catalog()[0].discoverable).toBe(true);
    // and OFF again (unchecked checkbox sends nothing)
    await f.app.request("/admin/products/late-reg", form({ title: "Late Reg", price: "$0.01" }));
    expect(f.catalog()[0].discoverable).toBeUndefined();
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

  test("demand pricing: floor/ceiling from the form, sane step/window defaults, no fixed price", async () => {
    const res = await f.app.request(
      "/admin/products",
      form({ type: "folder", title: "Surge", price: "0.05", pricingMode: "demand", floor: "0.001", ceiling: "0.10" }),
    );
    expect(res.status).toBe(302);
    const [p] = f.catalog();
    expect(p.pricing).toEqual({ mode: "demand", floor: "$0.001", ceiling: "$0.10", step: 0.1, windowMinutes: 15 });
    expect(p.price).toBeUndefined();
  });

  test("discoverable checkbox lands on the entry", async () => {
    await f.app.request("/admin/products", form({ type: "folder", title: "Found", price: "0.01", discoverable: "on" }));
    expect(f.catalog()[0].discoverable).toBe(true);
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

describe("filenames and folder selection", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => (f = fixture()));

  test("single-file upload with spaces in the filename works — stored name is dashed", async () => {
    const res = await f.app.request(
      "/admin/products",
      form({ type: "file", title: "Soil Book", price: "$1.00" }, { name: "The Soil Biome (final).pdf", content: "pdf" }),
    );
    expect(res.status).toBe(302);
    const [p] = f.catalog();
    expect(p.route).toBe("GET /soil-book/The-Soil-Biome-(final).pdf");
    expect(existsSync(join(f.dir, "content", "soil-book", "The-Soil-Biome-(final).pdf"))).toBe(true);
  });

  test("folder flow offers a whole-folder picker as well as multi-file select", async () => {
    const html = await (await f.app.request("/admin/products/new")).text();
    expect(html).toContain("webkitdirectory");
  });
});
