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

interface CatalogEntry {
  sku: string;
  title: string;
  description?: string;
  price: string | number;
  route: string;
  url?: string;
  files?: Array<{ path: string; url: string }>;
}

function catalogEntries(deps: HandlerDeps): CatalogEntry[] {
  return deps.products().map((p) => {
    const pattern = routePath(p);
    const files = p.contentDir
      ? listSafe(p.contentDir).map((rel) => ({ path: rel, url: fileUrl(pattern, rel) }))
      : undefined;
    return {
      sku: p.sku,
      title: p.title,
      description: p.description,
      price: p.price,
      route: p.route,
      ...(files ? { files } : { url: pattern }),
    };
  });
}

export function catalogJson(deps: HandlerDeps): Handler {
  return (c) => c.json({ products: catalogEntries(deps) });
}

export function catalogHtml(deps: HandlerDeps): Handler {
  return (c) => {
    const items = catalogEntries(deps)
      .map((e) => {
        const fileList = e.files
          ? `<ul>${e.files
              .map((f) => `<li><a href="${f.url}">${escapeHtml(f.path)}</a></li>`)
              .join("")}</ul>`
          : "";
        return `<li><strong>${escapeHtml(e.title)}</strong> — ${escapeHtml(priceLabel(e.price))}${
          e.description ? `<p>${escapeHtml(e.description)}</p>` : ""
        }${fileList}</li>`;
      })
      .join("");
    return c.html(`<!doctype html><html><head><title>Catalog</title></head><body><h1>Catalog</h1><ul>${items}</ul></body></html>`);
  };
}

function truncatePayer(payer: string): string {
  return `${payer.slice(0, 6)}…${payer.slice(-4)}`;
}

export function feedPage(deps: HandlerDeps): Handler {
  return (c) => {
    const rows = deps.store
      .recentSales()
      .map(
        (s) =>
          `<tr><td>${escapeHtml(s.ts)}</td><td>${escapeHtml(s.title)}</td><td>$${escapeHtml(s.amountUsdc)}</td><td>${escapeHtml(truncatePayer(s.payer))}</td></tr>`,
      )
      .join("");
    return c.html(`<!doctype html><html><head><title>Recent Sales</title></head><body><h1>Recent Sales</h1><table><thead><tr><th>Time</th><th>Product</th><th>Amount</th><th>Payer</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
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
