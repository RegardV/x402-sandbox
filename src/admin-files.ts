import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Hono } from "hono";

import type { ProductConfig } from "./config.js";
import type { Store } from "./db.js";
import { listSafe, resolveSafe } from "./resolve-safe.js";
import { page } from "./ui.js";

export interface FilesDeps {
  products(): ProductConfig[];
  store: Store;
}

const VIEW_MIME: Record<string, string> = {
  ".md": "text/plain", ".txt": "text/plain", ".csv": "text/plain", ".json": "text/plain",
  ".html": "text/plain", ".pdf": "application/pdf",
};

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_UPLOAD = 50 * 1024 * 1024; // ponytail: 50MB in-memory cap; stream to disk if bigger files matter
const DENIED_EXT = new Set([".env", ".key", ".pem"]);

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Same rules resolveSafe enforces on reads, applied to an upload name. */
export function safeUploadName(raw: string): string | null {
  const name = basename(raw.replaceAll("\\", "/")); // strip any path components
  if (!name || name.startsWith(".")) return null;
  if (DENIED_EXT.has(extname(name).toLowerCase())) return null;
  return name;
}

/** Web file management for contentDir products: list, upload, delete.
 *  Mounted under the admin basic-auth gate — no auth of its own.
 *  No reload needed: directory products serve/list files live. */
export function adminFiles(deps: FilesDeps): Hono {
  const app = new Hono();

  const dirProduct = (sku: string): ProductConfig | undefined =>
    deps.products().find((p) => p.sku === sku && p.contentDir);

  app.get("/files/:sku", (c) => {
    const p = dirProduct(c.req.param("sku"));
    if (!p) return c.text("Not Found", 404);
    const base = p.route.slice(p.route.indexOf(" ") + 1, -2); // "GET /lib/*" -> "/lib"
    const paid = deps.store.paidCountsByPath();
    const files = listSafe(p.contentDir!);
    let totalBytes = 0;
    const rows = files
      .map((rel) => {
        const abs = resolveSafe(p.contentDir!, rel);
        const size = abs ? statSync(abs).size : 0;
        totalBytes += size;
        const publicPath = `${base}/${rel.split("/").map(encodeURIComponent).join("/")}`;
        const sales = paid[publicPath] ?? paid[`${base}/${rel}`] ?? 0;
        return `<tr>
          <td><a href="/admin/files/${encodeURIComponent(p.sku)}/raw?path=${encodeURIComponent(rel)}" title="view content (free, admin-only)">${escapeHtml(rel)}</a></td>
          <td><code class="muted" style="font-size:.8rem">${escapeHtml(publicPath)}</code></td>
          <td class="size">${humanSize(size)}</td>
          <td class="num">${sales}</td>
          <td><form method="post" action="/admin/files/${encodeURIComponent(p.sku)}/delete" style="display:inline">
          <input type="hidden" name="path" value="${escapeHtml(rel)}">
          <button class="danger" onclick="return confirm('Delete ${escapeHtml(rel)}?')">delete</button></form></td></tr>`;
      })
      .join("");
    const revenue = deps.store.topProducts(1000).find((t) => t.sku === p.sku)?.revenue ?? 0;
    const priceLabel = p.pricing ? `${p.pricing.floor}–${p.pricing.ceiling} (demand)` : String(p.price);
    const body = `
      <h1>Files — ${escapeHtml(p.title)}</h1>
      <p class="lede"><a href="/admin">← Admin</a> · <a href="/admin/products/${encodeURIComponent(p.sku)}/edit">edit product</a> · click a filename to view its content free (admin-only)</p>
      <div class="tiles">
        <div class="tile"><div class="k">price per file</div><div class="v" style="font-size:1.1rem">${escapeHtml(priceLabel)}</div></div>
        <div class="tile"><div class="k">files</div><div class="v">${files.length}</div></div>
        <div class="tile"><div class="k">total size</div><div class="v" style="font-size:1.1rem">${humanSize(totalBytes)}</div></div>
        <div class="tile"><div class="k">revenue</div><div class="v" style="font-size:1.1rem">$${revenue.toFixed(2)}</div></div>
      </div>
      <form class="panel" method="post" action="/admin/files/${encodeURIComponent(p.sku)}/upload" enctype="multipart/form-data">
        <input type="file" name="file" multiple required> <button>Upload — instantly for sale</button>
      </form>
      <div class="card wrap"><table><thead><tr><th>file</th><th>public url</th><th>size</th><th>sales</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">empty — upload a file to start selling</td></tr>'}</tbody></table></div>`;
    return c.html(page(`Files — ${p.title}`, body, { admin: true }));
  });

  // Operator preview: serve a file's content free, admin-gated by the mount.
  app.get("/files/:sku/raw", (c) => {
    const p = dirProduct(c.req.param("sku"));
    if (!p) return c.text("Not Found", 404);
    const abs = resolveSafe(p.contentDir!, c.req.query("path") ?? "");
    if (!abs) return c.text("Not Found", 404);
    const type = VIEW_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
    return c.body(new Uint8Array(readFileSync(abs)), 200, { "content-type": type });
  });

  app.post("/files/:sku/upload", async (c) => {
    const p = dirProduct(c.req.param("sku"));
    if (!p) return c.text("Not Found", 404);
    const body = await c.req.parseBody({ all: true });
    const raw = body["file"];
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (!files.length) return c.text("no file", 400);

    // All-or-nothing: validate the whole batch before writing anything.
    const batch: Array<{ name: string; file: File }> = [];
    for (const file of files) {
      const name = safeUploadName(file.name);
      if (!name) return c.text(`"${file.name}": filename not allowed (no dotfiles, no .env/.key/.pem) — nothing uploaded`, 400);
      if (file.size > MAX_UPLOAD) return c.text(`"${file.name}": too large (max ${MAX_UPLOAD / 1024 / 1024}MB) — nothing uploaded`, 400);
      batch.push({ name, file });
    }
    for (const { name, file } of batch) {
      writeFileSync(join(p.contentDir!, name), Buffer.from(await file.arrayBuffer()));
      console.log(`[admin-audit] ${new Date().toISOString()} upload ${p.sku}/${name} (${file.size}B)`);
    }
    return c.redirect(`/admin/files/${encodeURIComponent(p.sku)}`);
  });

  app.post("/files/:sku/delete", async (c) => {
    const p = dirProduct(c.req.param("sku"));
    if (!p) return c.text("Not Found", 404);
    const rel = String((await c.req.parseBody())["path"] ?? "");
    const abs = resolveSafe(p.contentDir!, rel); // guard: only real files inside the dir
    if (!abs) return c.text("Not Found", 404);
    unlinkSync(abs);
    console.log(`[admin-audit] ${new Date().toISOString()} delete-file ${p.sku}/${rel}`);
    return c.redirect(`/admin/files/${encodeURIComponent(p.sku)}`);
  });

  return app;
}
