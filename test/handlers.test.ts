import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogHtml,
  catalogJson,
  feedPage,
  matchProduct,
  paidContent,
  precheck404,
  subPath,
  type HandlerDeps,
} from "../src/handlers.js";
import type { ProductConfig } from "../src/config.js";
import { Store } from "../src/db.js";

const PAYER = "0xAbCdEf1234567890123456789012345678904321";

let tmp: string;
let store: Store;
let products: ProductConfig[];
let deps: HandlerDeps;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "handlers-"));
  mkdirSync(join(tmp, "docs", "sub"), { recursive: true });
  writeFileSync(join(tmp, "docs", "guide.md"), "# Guide");
  writeFileSync(join(tmp, "docs", "data.zip"), Buffer.from([0x50, 0x4b, 3, 4]));
  writeFileSync(join(tmp, "docs", ".secret"), "nope");
  writeFileSync(join(tmp, "docs", "sub", "file name.md"), "spaced");
  mkdirSync(join(tmp, "content"));
  writeFileSync(join(tmp, "content", "a.md"), "# A");

  products = [
    {
      sku: "a",
      title: "Article A",
      description: "an article",
      price: "$0.05",
      route: "GET /files/a.md",
      contentPath: "./content/a.md",
      mimeType: "text/markdown",
    },
    {
      sku: "docs",
      title: "Docs Pack",
      price: "$0.10",
      route: "GET /docs/*",
      contentDir: join(tmp, "docs"),
    },
    {
      sku: "report",
      title: "Report",
      price: 1,
      route: "GET /api/:id/report",
      contentPath: "./content/a.md",
    },
    {
      sku: "gone",
      title: "Missing",
      price: "$9.99",
      route: "GET /files/missing.pdf",
      contentPath: "./content/missing.pdf",
    },
    {
      sku: "booksdemo",
      title: "Books Demo",
      price: "$0.02",
      route: "GET /booksdemo",
      proxyUrl: "http://127.0.0.1:8404/report",
      humanForm: [
        { name: "wallet", label: "Seller wallet", type: "text", pattern: "0x[0-9a-fA-F]{40}", required: true },
        { name: "period", label: "Period", type: "month", required: true },
        { name: "to", label: "To", type: "month", blankLabel: "— single month —" },
        { name: "jurisdiction", label: "Jurisdiction", type: "select", options: [
          { value: "NONE", label: "None" }, { value: "ZA", label: "South Africa" },
        ] },
      ],
    },
  ];

  store = new Store(":memory:");
  store.syncProducts([
    { sku: "docs", title: "Docs Pack", price: "$0.10", network: "eip155:84532" },
  ]);
  const id = store.productBySku("docs")!.id;
  store.insertSettlement({
    ts: "2026-07-15T10:00:00.000Z",
    productId: id,
    amountUsdc: "0.10",
    payer: PAYER,
    txHash: "0xfeed",
    network: "eip155:84532",
  });

  deps = { store, products: () => products, baseDir: tmp };
});

afterAll(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("matchProduct", () => {
  test("exact route", () => {
    expect(matchProduct(products, "GET", "/files/a.md")?.sku).toBe("a");
  });

  test(":param matches exactly one segment", () => {
    expect(matchProduct(products, "GET", "/api/42/report")?.sku).toBe("report");
    expect(matchProduct(products, "GET", "/api/42/extra/report")).toBeUndefined();
  });

  test("trailing /* matches any deeper path", () => {
    expect(matchProduct(products, "GET", "/docs/guide.md")?.sku).toBe("docs");
    expect(matchProduct(products, "GET", "/docs/sub/file.md")?.sku).toBe("docs");
  });

  test("method mismatch does not match", () => {
    expect(matchProduct(products, "POST", "/files/a.md")).toBeUndefined();
  });

  test("no match for unknown path", () => {
    expect(matchProduct(products, "GET", "/nope")).toBeUndefined();
  });
});

describe("subPath", () => {
  test("returns file sub-path relative to the dir", () => {
    const dir = products[1]!;
    expect(subPath(dir, "/docs/sub/file.md")).toBe("sub/file.md");
  });

  test("URL-decodes", () => {
    const dir = products[1]!;
    expect(subPath(dir, "/docs/sub/file%20name.md")).toBe("sub/file name.md");
  });
});

describe("catalogJson", () => {
  test("lists every product with title/description/price/route", async () => {
    const app = new Hono().get("/catalog.json", catalogJson(deps));
    const res = await app.request("/catalog.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toHaveLength(5);
    const a = body.products.find((p: any) => p.sku === "a");
    expect(a).toMatchObject({
      title: "Article A",
      description: "an article",
      price: "$0.05",
      route: "GET /files/a.md",
    });
  });

  test("expands contentDir products into per-file URLs via listSafe", async () => {
    const app = new Hono().get("/catalog.json", catalogJson(deps));
    const body = await (await app.request("/catalog.json")).json();
    const docs = body.products.find((p: any) => p.sku === "docs");
    const urls = docs.files.map((f: any) => f.url);
    expect(urls).toContain("/docs/guide.md");
    expect(urls).toContain("/docs/data.zip");
    expect(urls).toContain("/docs/sub/file%20name.md");
    expect(JSON.stringify(docs.files)).not.toContain(".secret");
  });
});

describe("catalogHtml", () => {
  test("contains titles and prices", async () => {
    const app = new Hono().get("/catalog", catalogHtml(deps));
    const res = await app.request("/catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Article A");
    expect(html).toContain("$0.05");
    expect(html).toContain("Docs Pack");
    expect(html).toContain("$0.10");
  });

  test("links each file inside contentDir products", async () => {
    const app = new Hono().get("/catalog", catalogHtml(deps));
    const html = await (await app.request("/catalog")).text();
    expect(html).toContain('href="/docs/guide.md"');
    expect(html).toContain('href="/docs/data.zip"');
    expect(html).not.toContain(".secret");
  });

  test("renders a capture form for humanForm products, not a bare link", async () => {
    const app = new Hono().get("/catalog", catalogHtml(deps));
    const html = await (await app.request("/catalog")).text();
    // GET form navigates to the product route so the paywall fires WITH params
    expect(html).toContain('<form class="buyform" method="get" action="/booksdemo">');
    expect(html).toContain('name="wallet"');
    // month field renders as a recent-months dropdown, not native <input type=month>
    expect(html).toContain('<select name="period">');
    expect(html).toMatch(/<option value="\d{4}-\d{2}">[A-Z][a-z]+ \d{4}<\/option>/);
    expect(html).not.toContain('type="month"');
    // optional "to" month field carries a leading blank option (single-month default)
    expect(html).toContain('<select name="to">');
    expect(html).toContain('<option value="">— single month —</option>');
    expect(html).toContain('<select name="jurisdiction">');
    expect(html).toContain('<option value="ZA">South Africa</option>');
    // the bare "<a href="/booksdemo">" link should NOT be the body for this product
    expect(html).not.toContain('<a href="/booksdemo"');
  });
});

describe("feedPage", () => {
  test("shows sale with truncated payer, never the full address", async () => {
    const app = new Hono().get("/feed", feedPage(deps));
    const res = await app.request("/feed");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Docs Pack");
    expect(html).toContain("0.10");
    expect(html).toContain("0xAbCd…4321");
    expect(html).not.toContain(PAYER);
  });
});

describe("precheck404", () => {
  function appWithDownstream() {
    let reached = false;
    const app = new Hono();
    app.use("*", precheck404(deps));
    app.all("*", (c) => {
      reached = true;
      return c.text("downstream");
    });
    return { app, wasReached: () => reached };
  }

  test("404 for missing file under contentDir, downstream not called", async () => {
    const { app, wasReached } = appWithDownstream();
    const res = await app.request("/docs/does-not-exist.md");
    expect(res.status).toBe(404);
    expect(wasReached()).toBe(false);
  });

  test("passes through for existing contentDir file", async () => {
    const { app, wasReached } = appWithDownstream();
    const res = await app.request("/docs/guide.md");
    expect(res.status).toBe(200);
    expect(wasReached()).toBe(true);
  });

  test("404 for contentPath product whose file is missing", async () => {
    const { app, wasReached } = appWithDownstream();
    const res = await app.request("/files/missing.pdf");
    expect(res.status).toBe(404);
    expect(wasReached()).toBe(false);
  });

  test("ignores non-product paths", async () => {
    const { app, wasReached } = appWithDownstream();
    const res = await app.request("/totally/unrelated");
    expect(res.status).toBe(200);
    expect(wasReached()).toBe(true);
  });
});

describe("paidContent", () => {
  function paidApp() {
    const app = new Hono();
    app.all("*", paidContent(deps));
    return app;
  }

  test("serves contentPath bytes with explicit mimeType", async () => {
    const res = await paidApp().request("/files/a.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# A");
  });

  test("contentDir: infers text/markdown for .md", async () => {
    const res = await paidApp().request("/docs/guide.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# Guide");
  });

  test("contentDir: infers application/zip and serves exact bytes", async () => {
    const res = await paidApp().request("/docs/data.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 3, 4]),
    );
  });

  test("traversal attempt (encoded ../) is 404", async () => {
    const res = await paidApp().request("/docs/%2e%2e/content/a.md");
    expect(res.status).toBe(404);
  });

  test("dotfile is 404", async () => {
    const res = await paidApp().request("/docs/.secret");
    expect(res.status).toBe(404);
  });
});
