import type { Handler, MiddlewareHandler } from "hono";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ProductConfig } from "./config.js";
import type { Store } from "./db.js";
import { listSafe, resolveSafe } from "./resolve-safe.js";

export interface HandlerDeps {
  store: Store;
  products(): ProductConfig[];
  baseDir: string;
}

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".epub": "application/epub+zip",
};

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function priceLabel(price: string | number): string {
  return typeof price === "number" ? `$${price}` : price;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EXCERPT_EXT = new Set([".md", ".txt"]);
const EXCERPT_CHARS = 160;

/** Deliberate teaser for preview:true products: first chars of a text file. */
function excerptOf(absFile: string): string | undefined {
  if (!EXCERPT_EXT.has(extname(absFile).toLowerCase())) return undefined;
  try {
    const text = readFileSync(absFile, "utf8").slice(0, EXCERPT_CHARS * 4);
    const cleaned = text.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
    return cleaned.length > EXCERPT_CHARS ? `${cleaned.slice(0, EXCERPT_CHARS)}…` : cleaned;
  } catch {
    return undefined;
  }
}

import { page } from "./ui.js";
export { page };

/** "/docs/*" → "/docs"; the URL a rel path lives under. */
function fileUrl(routePath: string, rel: string): string {
  const base = routePath.slice(0, -2);
  return `${base}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** Path pattern of a validated "<METHOD> /path" route. */
function routePath(p: ProductConfig): string {
  return p.route.slice(p.route.indexOf(" ") + 1);
}

export function matchProduct(
  products: ProductConfig[],
  method: string,
  path: string,
): ProductConfig | undefined {
  return products.find((p) => {
    const m = p.route.slice(0, p.route.indexOf(" "));
    const pattern = routePath(p);
    if (m !== method) return false;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return path.startsWith(prefix + "/") && path.length > prefix.length + 1;
    }
    const patSegs = pattern.split("/").filter(Boolean);
    const segs = path.split("/").filter(Boolean);
    if (patSegs.length !== segs.length) return false;
    return patSegs.every((ps, i) => ps.startsWith(":") || ps === segs[i]);
  });
}

export function subPath(product: ProductConfig, path: string): string {
  const pattern = routePath(product);
  const raw = path.slice(pattern.length - 1); // pattern ends "/*": keep after "<prefix>/"
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed encoding: let resolveSafe reject it downstream
  }
}

interface CatalogFile {
  path: string;
  url: string;
  size?: number;
  excerpt?: string;
}

interface CatalogEntry {
  sku: string;
  title: string;
  description?: string;
  price: string | number;
  route: string;
  url?: string;
  size?: number;
  files?: CatalogFile[];
}

function statSize(abs: string): number | undefined {
  try {
    return statSync(abs).size;
  } catch {
    return undefined;
  }
}

/** Fixed price from config, or the live repriced value for demand products. */
function displayPrice(deps: HandlerDeps, p: ProductConfig): string | number {
  if (!p.pricing) return p.price!;
  const live = deps.store.productBySku(p.sku)?.priceUsdc;
  return live ? `$${live}` : p.pricing.floor;
}

function catalogEntries(deps: HandlerDeps): CatalogEntry[] {
  return deps.products().map((p) => {
    const pattern = routePath(p);
    if (p.contentDir) {
      const dir = p.contentDir;
      const files = listSafe(dir).map((rel): CatalogFile => {
        const abs = resolveSafe(dir, rel);
        return {
          path: rel,
          url: fileUrl(pattern, rel),
          ...(abs ? { size: statSize(abs) } : {}),
          ...(p.preview && abs ? { excerpt: excerptOf(abs) } : {}),
        };
      });
      return { sku: p.sku, title: p.title, description: p.description, price: displayPrice(deps, p), route: p.route, files };
    }
    const abs = resolve(deps.baseDir, (p.contentPath ?? p.bundlePath)!);
    return {
      sku: p.sku,
      title: p.title,
      description: p.description,
      price: displayPrice(deps, p),
      route: p.route,
      url: pattern,
      size: statSize(abs),
      ...(p.preview ? { files: undefined } : {}),
    };
  });
}

export function catalogJson(deps: HandlerDeps): Handler {
  return (c) => c.json({ products: catalogEntries(deps) });
}

export function catalogHtml(deps: HandlerDeps): Handler {
  return (c) => {
    const cards = catalogEntries(deps)
      .map((e) => {
        const head = `<h2>${escapeHtml(e.title)}<span class="price">${escapeHtml(priceLabel(e.price))}</span></h2>`;
        const desc = e.description ? `<p class="desc">${escapeHtml(e.description)}</p>` : "";
        let body = "";
        if (e.files) {
          const rows = e.files
            .map(
              (f) =>
                `<tr><td><a href="${f.url}">${escapeHtml(f.path)}</a>${
                  f.excerpt ? `<p class="excerpt">${escapeHtml(f.excerpt)}</p>` : ""
                }</td><td class="size">${f.size !== undefined ? humanSize(f.size) : ""}</td></tr>`,
            )
            .join("");
          body = e.files.length
            ? `<table class="files">${rows}</table>`
            : `<p class="muted">No files yet — drop files into this product's folder to sell them.</p>`;
        } else if (e.url) {
          body = `<table class="files"><tr><td><a href="${e.url}">${escapeHtml(e.url)}</a></td><td class="size">${
            e.size !== undefined ? humanSize(e.size) : ""
          }</td></tr></table>`;
        }
        return `<section class="card">${head}${desc}${body}</section>`;
      })
      .join("");
    return c.html(
      page(
        "Store",
        `<h1>Store</h1><p class="lede">Pay per file with USDC via x402 — click a file to get a payment page. Agents: use <a href="/catalog.json">/catalog.json</a>.</p>${cards}`,
      ),
    );
  };
}

function truncatePayer(payer: string): string {
  return `${payer.slice(0, 6)}…${payer.slice(-4)}`;
}

function relativeTime(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function feedPage(deps: HandlerDeps): Handler {
  return (c) => {
    const sales = deps.store.recentSales();
    const rows = sales
      .map(
        (s) =>
          `<tr><td title="${escapeHtml(s.ts)}">${escapeHtml(relativeTime(s.ts))}</td><td>${escapeHtml(s.title)}</td><td>$${escapeHtml(s.amountUsdc)}</td><td class="muted">${escapeHtml(truncatePayer(s.payer))}</td></tr>`,
      )
      .join("");
    const body = sales.length
      ? `<table class="feed"><thead><tr><th>When</th><th>Product</th><th>Amount</th><th>Buyer</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">No sales yet.</p>`;
    return c.html(page("Recent Sales", `<h1>Recent Sales</h1>${body}`));
  };
}

/** Absolute file for a matched product, or null if missing/denied. */
function productFile(deps: HandlerDeps, p: ProductConfig, path: string): string | null {
  if (p.contentDir) return resolveSafe(p.contentDir, subPath(p, path));
  const abs = resolve(deps.baseDir, (p.contentPath ?? p.bundlePath)!);
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

export function precheck404(deps: HandlerDeps): MiddlewareHandler {
  return async (c, next) => {
    const p = matchProduct(deps.products(), c.req.method, c.req.path);
    if (p && productFile(deps, p, c.req.path) === null) {
      return c.text("Not Found", 404);
    }
    await next();
  };
}

export function paidContent(deps: HandlerDeps): Handler {
  return (c) => {
    const p = matchProduct(deps.products(), c.req.method, c.req.path);
    const file = p && productFile(deps, p, c.req.path);
    if (!p || !file) return c.text("Not Found", 404);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file); // ponytail: readFileSync at sandbox scale, stream when files get big
    } catch {
      return c.text("Not Found", 404);
    }
    const type = p.mimeType ?? MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    return c.body(new Uint8Array(bytes), 200, { "content-type": type });
  };
}
