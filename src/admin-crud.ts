import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import type { Store } from "./db.js";
import { loadProducts, type ProductConfig } from "./config.js";

export interface CrudDeps {
  store: Store;
  productsPath: string; // products.json the gateway watches
  baseDir: string; // for loadProducts path validation
  onCatalogChange?: () => void; // server hot-reload hook, call after every successful write
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function csvField(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function readCatalog(productsPath: string): ProductConfig[] {
  const parsed = JSON.parse(readFileSync(productsPath, "utf8")) as { products: ProductConfig[] };
  return parsed.products;
}

// Atomic write: temp file + rename, so a crash/reload never observes a half-written catalog.
function writeCatalog(productsPath: string, products: ProductConfig[]): void {
  const tmp = `${productsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ products }, null, 2));
  renameSync(tmp, productsPath);
}

const FORM_FIELDS = ["title", "description", "price", "route", "contentPath", "bundlePath", "contentDir", "mimeType"] as const;

/** Merge submitted form fields onto `base` (or start fresh for create). Empty strings are dropped. */
function buildEntry(base: ProductConfig | undefined, sku: string, body: Record<string, unknown>): ProductConfig {
  const entry: Record<string, unknown> = { ...base, sku };
  for (const field of FORM_FIELDS) {
    const raw = body[field];
    if (typeof raw === "string" && raw !== "") entry[field] = raw;
  }
  // The three content-source fields are mutually exclusive: if the form supplied any of
  // them, drop whichever ones it left blank instead of keeping a stale value from `base`.
  const sources = ["contentPath", "bundlePath", "contentDir"] as const;
  if (sources.some((f) => typeof body[f] === "string" && body[f] !== "")) {
    for (const f of sources) {
      if (!(typeof body[f] === "string" && body[f] !== "")) delete entry[f];
    }
  }
  if (body.preview === "on" || body.preview === "true") entry.preview = true;
  else delete entry.preview;
  return entry as unknown as ProductConfig;
}

function renderForm(opts: { action: string; sku?: string; product?: Partial<ProductConfig>; error?: string }): string {
  const p = opts.product ?? {};
  const field = (name: string, value: unknown) => `<input name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${opts.sku ? "Edit" : "New"} product</title></head><body>
<h1>${opts.sku ? `Edit ${escapeHtml(opts.sku)}` : "New product"}</h1>
${opts.error ? `<p style="color:red">${escapeHtml(opts.error)}</p>` : ""}
<form method="post" action="${opts.action}">
<p>sku ${opts.sku ? escapeHtml(opts.sku) : field("sku", p.sku)}</p>
<p>title ${field("title", p.title)}</p>
<p>description ${field("description", p.description)}</p>
<p>price ${field("price", p.price)}</p>
<p>route ${field("route", p.route)}</p>
<p>contentPath ${field("contentPath", p.contentPath)}</p>
<p>bundlePath ${field("bundlePath", p.bundlePath)}</p>
<p>contentDir ${field("contentDir", p.contentDir)}</p>
<p>mimeType ${field("mimeType", p.mimeType)}</p>
<p><label><input type="checkbox" name="preview" ${p.preview ? "checked" : ""}> preview</label></p>
<p><button type="submit">Save</button></p>
</form>
</body></html>`;
}

/** Validate-then-write helper shared by create/update/delete: builds the whole next catalog,
 * validates it with loadProducts before ever touching disk, then writes atomically. */
function validateAndWrite(deps: CrudDeps, nextProducts: ProductConfig[]): { error: string } | { ok: true } {
  try {
    loadProducts(JSON.stringify({ products: nextProducts }), deps.baseDir);
  } catch (err) {
    return { error: (err as Error).message };
  }
  writeCatalog(deps.productsPath, nextProducts);
  return { ok: true };
}

export function adminCrud(deps: CrudDeps): Hono {
  const app = new Hono();
  // Auth is applied by whoever mounts this app (same gate as adminApp) — no auth middleware here.

  app.get("/products/new", (c) => c.html(renderForm({ action: "/products" })));

  app.post("/products", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const sku = typeof body.sku === "string" ? body.sku : "";
    const entry = buildEntry(undefined, sku, body);
    const catalog = readCatalog(deps.productsPath);
    const result = validateAndWrite(deps, [...catalog, entry]);
    if ("error" in result) {
      return c.html(renderForm({ action: "/products", product: entry, error: result.error }), 400);
    }
    console.log(`[admin-audit] ${new Date().toISOString()} create ${sku}`);
    deps.onCatalogChange?.();
    return c.redirect("/", 302);
  });

  app.get("/products/:sku/edit", (c) => {
    const sku = c.req.param("sku");
    const catalog = readCatalog(deps.productsPath);
    const product = catalog.find((p) => p.sku === sku);
    if (!product) return c.notFound();
    return c.html(renderForm({ action: `/products/${encodeURIComponent(sku)}`, sku, product }));
  });

  app.post("/products/:sku", async (c) => {
    const sku = c.req.param("sku");
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const catalog = readCatalog(deps.productsPath);
    const base = catalog.find((p) => p.sku === sku);
    const entry = buildEntry(base, sku, body);
    const nextProducts = catalog.map((p) => (p.sku === sku ? entry : p));
    const result = validateAndWrite(deps, nextProducts);
    if ("error" in result) {
      return c.html(renderForm({ action: `/products/${encodeURIComponent(sku)}`, sku, product: entry, error: result.error }), 400);
    }
    console.log(`[admin-audit] ${new Date().toISOString()} update ${sku}`);
    deps.onCatalogChange?.();
    return c.redirect("/", 302);
  });

  // ponytail: no separate enable/disable toggle route — delete covers the one Tier-1 mutation
  // (remove from products.json); add a toggle if "temporarily disable without losing config" is needed.
  app.post("/products/:sku/delete", (c) => {
    const sku = c.req.param("sku");
    const catalog = readCatalog(deps.productsPath);
    const nextProducts = catalog.filter((p) => p.sku !== sku);
    const result = validateAndWrite(deps, nextProducts);
    if ("error" in result) return c.text(result.error, 400);
    console.log(`[admin-audit] ${new Date().toISOString()} delete ${sku}`);
    deps.onCatalogChange?.();
    return c.redirect("/", 302);
  });

  app.get("/export/sales.csv", (c) => {
    const rows = deps.store.recentSales(1000);
    // ponytail: tx_hash isn't in recentSales (Store has no raw query escape hatch), so the
    // CSV omits it; extend Store with a settlement-joined query if callers need it.
    const lines = [
      "ts,sku,title,amount_usdc,payer",
      ...rows.map((r) => [r.ts, r.sku, r.title, r.amountUsdc, r.payer].map(csvField).join(",")),
    ];
    return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/csv" });
  });

  return app;
}
