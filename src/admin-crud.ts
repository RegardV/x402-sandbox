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

const FORM_FIELDS = ["title", "description", "price", "route", "contentPath", "bundlePath", "contentDir", "proxyUrl", "mimeType"] as const;

/** Merge submitted form fields onto `base` (or start fresh for create). Empty strings are dropped. */
function buildEntry(base: ProductConfig | undefined, sku: string, body: Record<string, unknown>): ProductConfig {
  const entry: Record<string, unknown> = { ...base, sku };
  for (const field of FORM_FIELDS) {
    const raw = body[field];
    if (typeof raw === "string" && raw !== "") entry[field] = raw;
  }
  // The three content-source fields are mutually exclusive: if the form supplied any of
  // them, drop whichever ones it left blank instead of keeping a stale value from `base`.
  const sources = ["contentPath", "bundlePath", "contentDir", "proxyUrl"] as const;
  if (sources.some((f) => typeof body[f] === "string" && body[f] !== "")) {
    for (const f of sources) {
      if (!(typeof body[f] === "string" && body[f] !== "")) delete entry[f];
    }
  }
  // Checkboxes: absent from the body means unchecked — remove, don't preserve stale true.
  if (body.preview === "on" || body.preview === "true") entry.preview = true;
  else delete entry.preview;
  if (body.discoverable === "on" || body.discoverable === "true") entry.discoverable = true;
  else delete entry.discoverable;
  return entry as unknown as ProductConfig;
}

const errorBox = (error?: string) =>
  error ? `<div class="card" style="border-color:var(--bad)"><span class="badge bad">error</span> ${escapeHtml(error)}</div>` : "";

/** The operator-facing add-product workflow: pick a path, see only that path's fields. */
function renderNewForm(opts: { error?: string; values?: Record<string, unknown> } = {}): string {
  const v = opts.values ?? {};
  const isFile = v.type === "file";
  const isDemand = v.pricingMode === "demand";
  const choice = (name: string, value: string, checked: boolean, title: string, desc: string) => `
    <label style="font-weight:400;display:flex;gap:.7rem;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:.8rem 1rem;cursor:pointer">
      <input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""} style="margin-top:.25rem">
      <span><strong>${title}</strong><br><span class="muted">${desc}</span></span>
    </label>`;
  const body = `
<h1>Add product</h1>
<p class="lede"><a href="/admin">← Admin</a> · pick what you're selling — sku, URL, and folders are set up for you.</p>
${errorBox(opts.error)}
<div class="card"><form class="stack" method="post" action="/admin/products" enctype="multipart/form-data">
  <label>What are you selling?</label>
  ${choice("type", "folder", !isFile, "A folder of files", "One price for the whole folder. Add and remove files any time — each file is instantly for sale. Best for collections: articles, datasets, a course.")}
  ${choice("type", "file", isFile, "A single file", "Upload one file now; it gets its own URL and price. Best for one document, book, or bundle.")}

  <div id="folder-fields" ${isFile ? "hidden" : ""}>
    <label>Files to start the folder with <input type="file" name="files" multiple></label>
    <label>…or select an entire folder <input type="file" name="files" multiple webkitdirectory></label>
    <p class="muted">Optional — you can add and remove files any time after creation. Folder selection copies the files in (flattened); subfolder structure is not kept.</p>
    <label style="font-weight:400"><input type="checkbox" name="preview" ${v.preview ? "checked" : ""}> Show a short text excerpt of md/txt files on the store</label>
  </div>
  <div id="file-fields" ${isFile ? "" : "hidden"}>
    <label>The file <input type="file" name="file"></label>
  </div>

  <label>Title <input name="title" required value="${escapeHtml(v.title)}" placeholder="Soil Guides"></label>
  <label>Description <input name="description" value="${escapeHtml(v.description)}" placeholder="optional — the sales pitch; for PDFs it's all a buyer sees"></label>

  <label>Pricing</label>
  ${choice("pricingMode", "fixed", !isDemand, "Fixed price", "You set it, it stays put.")}
  ${choice("pricingMode", "demand", isDemand, "Demand pricing", "Adjusts itself between a floor and a ceiling based on sales — dirt cheap when quiet, rises when selling.")}

  <div id="fixed-fields" ${isDemand ? "hidden" : ""}>
    <label>Price in USD <input name="price" value="${escapeHtml(v.price)}" placeholder="0.05"></label>
  </div>
  <div id="demand-fields" ${isDemand ? "" : "hidden"}>
    <label>Floor / ceiling in USD <span style="display:flex;gap:.5rem"><input name="floor" value="${escapeHtml(v.floor)}" placeholder="0.001"> <input name="ceiling" value="${escapeHtml(v.ceiling)}" placeholder="0.10"></span></label>
  </div>

  <label style="font-weight:400"><input type="checkbox" name="discoverable" ${v.discoverable ? "checked" : ""}> List in x402 discovery registries (Bazaar) so AI agents can find it <span class="muted">— changeable later in edit</span></label>
  <div><button type="submit">Create product</button></div>
</form></div>
<p class="muted">Need full control (custom routes, existing paths)? Edit <code>products.json</code> directly — it hot-reloads.</p>
<script class="type-toggle">
  const upd = () => {
    const isFile = document.querySelector('input[name=type]:checked').value === "file";
    document.getElementById("file-fields").hidden = !isFile;
    document.getElementById("folder-fields").hidden = isFile;
    const demand = document.querySelector('input[name=pricingMode]:checked').value === "demand";
    document.getElementById("fixed-fields").hidden = demand;
    document.getElementById("demand-fields").hidden = !demand;
  };
  document.querySelectorAll('input[name=type],input[name=pricingMode]').forEach((el) => el.addEventListener("change", upd));
  upd();
</script>`;
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
${field("proxyUrl", p.proxyUrl)}
${field("mimeType", p.mimeType)}
<label style="font-weight:400"><input type="checkbox" name="preview" ${p.preview ? "checked" : ""}> Show text excerpts on the store (preview)</label>
<label style="font-weight:400"><input type="checkbox" name="discoverable" ${p.discoverable ? "checked" : ""}> List in x402 discovery registries (Bazaar)</label>
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
    const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;

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
    // Validate every upload BEFORE creating anything — one bad file rejects the whole creation.
    let writes: Array<{ name: string; file: File }> = [];
    if (body.type === "file") {
      const raw = body.file;
      const file = Array.isArray(raw) ? raw[0] : raw;
      if (!(file instanceof File) || file.size === 0) return fail("upload a file for a single-file product");
      const rawName = safeUploadName(file.name);
      if (!rawName) return fail(`"${file.name}": filename not allowed (no dotfiles, no .env/.key/.pem)`);
      const name = rawName.replace(/\s+/g, "-"); // spaces break exact routes and URLs
      writes = [{ name, file }];
      entry.route = `GET /${sku}/${name}`;
      entry.contentPath = `./content/${sku}/${name}`;
    } else {
      const raw = body.files;
      const files = (Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []).filter(
        (f): f is File => f instanceof File && f.size > 0,
      );
      for (const file of files) {
        const name = safeUploadName(file.name);
        if (!name) return fail(`"${file.name}": filename not allowed (no dotfiles, no .env/.key/.pem) — nothing created`);
        writes.push({ name, file });
      }
      entry.route = `GET /${sku}/*`;
      entry.contentDir = `./content/${sku}`;
    }

    mkdirSync(productDir, { recursive: true });
    const catalog = readCatalog(deps.productsPath);
    const result = validateAndWrite(deps, [...catalog, entry as unknown as ProductConfig]);
    if ("error" in result) return fail(result.error);
    for (const { name, file } of writes) {
      writeFileSync(join(productDir, name), Buffer.from(await file.arrayBuffer()));
    }
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
