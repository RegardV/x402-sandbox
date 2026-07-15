import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Store } from "./db.js";
import { loadProducts, type ProductConfig } from "./config.js";
import { safeUploadName } from "./admin-files.js";
import { page } from "./ui.js";

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

const errorBox = (error?: string) =>
  error ? `<div class="card" style="border-color:var(--bad)"><span class="badge bad">error</span> ${escapeHtml(error)}</div>` : "";

/** The operator-facing add-product workflow: type + title + price, everything else derived. */
function renderNewForm(opts: { error?: string; values?: Record<string, unknown> } = {}): string {
  const v = opts.values ?? {};
  const body = `
<h1>Add product</h1>
<p class="lede"><a href="/admin">← Admin</a> · pick what you're selling — sku, URL, and folders are set up for you.</p>
${errorBox(opts.error)}
<div class="card"><form class="stack" method="post" action="/admin/products" enctype="multipart/form-data">
  <label>What are you selling?
    <label style="font-weight:400"><input type="radio" name="type" value="folder" ${v.type !== "file" ? "checked" : ""}> A folder — every file you drop in is for sale at one price</label>
    <label style="font-weight:400"><input type="radio" name="type" value="file" ${v.type === "file" ? "checked" : ""}> A single file — upload it now</label>
  </label>
  <label>Title <input name="title" required value="${escapeHtml(v.title)}" placeholder="Soil Guides"></label>
  <label>Pricing
    <label style="font-weight:400"><input type="radio" name="pricingMode" value="fixed" ${v.pricingMode !== "demand" ? "checked" : ""}> Fixed price</label>
    <label style="font-weight:400"><input type="radio" name="pricingMode" value="demand" ${v.pricingMode === "demand" ? "checked" : ""}> Demand pricing — adjusts automatically between a floor and ceiling based on sales</label>
  </label>
  <label>Price in USD (fixed) <input name="price" value="${escapeHtml(v.price)}" placeholder="0.05"></label>
  <label>Floor / ceiling (demand) <span style="display:flex;gap:.5rem"><input name="floor" value="${escapeHtml(v.floor)}" placeholder="0.001"> <input name="ceiling" value="${escapeHtml(v.ceiling)}" placeholder="0.10"></span></label>
  <label>Description <input name="description" value="${escapeHtml(v.description)}" placeholder="optional — shown on the store"></label>
  <label>File (single-file products) <input type="file" name="file"></label>
  <label style="font-weight:400"><input type="checkbox" name="preview" ${v.preview ? "checked" : ""}> Show a short text excerpt of md/txt files on the store</label>
  <label style="font-weight:400"><input type="checkbox" name="discoverable" ${v.discoverable ? "checked" : ""}> List in x402 discovery registries (Bazaar) so AI agents can find it</label>
  <div><button type="submit">Create product</button></div>
</form></div>
<p class="muted">Need full control (custom routes, existing paths)? Edit <code>products.json</code> directly — it hot-reloads.</p>`;
  return page("Add product", body, { admin: true });
}

/** Advanced edit form — full field set, used by /products/:sku/edit. */
function renderForm(opts: { action: string; sku?: string; product?: Partial<ProductConfig>; error?: string }): string {
  const p = opts.product ?? {};
  const field = (name: string, value: unknown) => `<label>${name} <input name="${name}" value="${escapeHtml(value)}"></label>`;
  const body = `
<h1>${opts.sku ? `Edit ${escapeHtml(opts.sku)}` : "New product"}</h1>
<p class="lede"><a href="/admin">← Admin</a></p>
${errorBox(opts.error)}
<div class="card"><form class="stack" method="post" action="${opts.action}">
${opts.sku ? "" : field("sku", p.sku)}
${field("title", p.title)}
${field("description", p.description)}
${field("price", p.price)}
${field("route", p.route)}
${field("contentPath", p.contentPath)}
${field("bundlePath", p.bundlePath)}
${field("contentDir", p.contentDir)}
${field("mimeType", p.mimeType)}
<label style="font-weight:400"><input type="checkbox" name="preview" ${p.preview ? "checked" : ""}> preview</label>
<div><button type="submit">Save</button></div>
</form></div>`;
  return page(opts.sku ? `Edit ${opts.sku}` : "New product", body, { admin: true });
}

const RESERVED_SKUS = new Set(["admin", "catalog", "feed", "catalog.json", "docs"]);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function normalizePrice(raw: string): string {
  return raw.startsWith("$") ? raw : `$${raw}`;
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

  app.get("/products/new", (c) => c.html(renderNewForm()));

  app.post("/products", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    // Advanced mode: an explicit route means the caller manages paths themselves.
    if (typeof body.route === "string" && body.route !== "") {
      const sku = typeof body.sku === "string" ? body.sku : "";
      const entry = buildEntry(undefined, sku, body);
      const catalog = readCatalog(deps.productsPath);
      const result = validateAndWrite(deps, [...catalog, entry]);
      if ("error" in result) {
        return c.html(renderForm({ action: "/admin/products", product: entry, error: result.error }), 400);
      }
      console.log(`[admin-audit] ${new Date().toISOString()} create ${sku}`);
      deps.onCatalogChange?.();
      return c.redirect("/admin", 302);
    }

    // Simple mode: derive sku/route/paths from type + title, create dirs, save upload.
    const fail = (error: string) => c.html(renderNewForm({ error, values: body }), 400);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return fail("title is required");
    const sku = slugify(typeof body.sku === "string" && body.sku !== "" ? body.sku : title);
    if (!sku || RESERVED_SKUS.has(sku)) return fail(`"${sku}" is not a usable product name — pick another title`);

    const entry: Record<string, unknown> = { sku, title };
    if (body.pricingMode === "demand") {
      const floor = typeof body.floor === "string" ? body.floor.trim() : "";
      const ceiling = typeof body.ceiling === "string" ? body.ceiling.trim() : "";
      if (!floor || !ceiling) return fail("demand pricing needs a floor and a ceiling");
      // step/window defaults are deliberate: 10% moves on a 15-minute window (edit products.json to tune)
      entry.pricing = { mode: "demand", floor: normalizePrice(floor), ceiling: normalizePrice(ceiling), step: 0.1, windowMinutes: 15 };
    } else {
      const priceRaw = typeof body.price === "string" ? body.price.trim() : "";
      if (!priceRaw) return fail("price is required for fixed pricing");
      entry.price = normalizePrice(priceRaw);
    }
    if (typeof body.description === "string" && body.description !== "") entry.description = body.description;
    if (body.preview === "on" || body.preview === "true") entry.preview = true;
    if (body.discoverable === "on" || body.discoverable === "true") entry.discoverable = true;

    const productDir = join(deps.baseDir, "content", sku);
    if (body.type === "file") {
      const file = body.file;
      if (!(file instanceof File) || file.size === 0) return fail("upload a file for a single-file product");
      const name = safeUploadName(file.name);
      if (!name) return fail("filename not allowed (no dotfiles, no .env/.key/.pem)");
      mkdirSync(productDir, { recursive: true });
      writeFileSync(join(productDir, name), Buffer.from(await file.arrayBuffer()));
      entry.route = `GET /${sku}/${name}`;
      entry.contentPath = `./content/${sku}/${name}`;
    } else {
      mkdirSync(productDir, { recursive: true });
      entry.route = `GET /${sku}/*`;
      entry.contentDir = `./content/${sku}`;
    }

    const catalog = readCatalog(deps.productsPath);
    const result = validateAndWrite(deps, [...catalog, entry as unknown as ProductConfig]);
    if ("error" in result) return fail(result.error);
    console.log(`[admin-audit] ${new Date().toISOString()} create ${sku}`);
    deps.onCatalogChange?.();
    return c.redirect(body.type === "file" ? "/admin" : `/admin/files/${encodeURIComponent(sku)}`, 302);
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
