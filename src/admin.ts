import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import type { ProductRow, Store } from './db.js';

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function kind(p: ProductRow): string {
  return p.bundlePath ? 'bundle' : p.contentDir ? 'dir' : 'file';
}

function table(headers: string[], rows: unknown[][]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}">none</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Read-only admin stats app, mounted by the server at /admin. */
export function adminApp(store: Store, adminPassword: string, network: string): Hono {
  const app = new Hono();
  app.use('*', basicAuth({ username: 'admin', password: adminPassword }));

  app.get('/', (c) => {
    const totals = store.totals(network);
    const conv = store.conversion();
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Admin</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;max-width:70rem}
table{border-collapse:collapse;margin:.5rem 0 1.5rem}
th,td{border:1px solid #ccc;padding:.3rem .6rem;text-align:left;font-size:.85rem}
th{background:#f4f4f4}
.tile{display:inline-block;border:1px solid #ccc;padding:.6rem 1rem;margin:0 .5rem 1rem 0}
</style></head><body>
<h1>Admin</h1>
<p><a href="/catalog">Store</a> · <a href="/feed">Public sales feed</a></p>
<p><a href="/admin/products/new">Add product</a> · <a href="/admin/export/sales.csv">Export sales CSV</a></p>

<h2>Products</h2>
<table><thead><tr><th>sku</th><th>title</th><th>price</th><th>network</th><th>kind</th><th>actions</th></tr></thead><tbody>
${
  store.activeProducts().length
    ? store.activeProducts().map((p) => `<tr><td>${escapeHtml(p.sku)}</td><td>${escapeHtml(p.title)}</td><td>${escapeHtml(p.priceUsdc)}</td><td>${escapeHtml(p.network)}</td><td>${escapeHtml(kind(p))}</td><td><a href="/admin/products/${encodeURIComponent(p.sku)}/edit">edit</a></td></tr>`).join('')
    : '<tr><td colspan="6">none</td></tr>'
}
</tbody></table>

<h2>Sales</h2>
<div class="tile">Total revenue: ${escapeHtml(totals.totalUsdc.toFixed(2))} USDC</div>
<div class="tile">Sales: ${escapeHtml(totals.saleCount)}</div>
<h3>Last 7 days</h3>
${table(
  ['day', 'earnings', 'sales'],
  store.daily(7).map((d) => [d.day, d.earnings.toFixed(2), d.sales]),
)}
<h3>Top products</h3>
${table(
  ['sku', 'title', 'sales', 'revenue'],
  store.topProducts().map((t) => [t.sku, t.title, t.sales, t.revenue.toFixed(2)]),
)}
<h3>Recent sales</h3>
${table(
  // ponytail: Store.recentSales() has no tx_hash column; tx hash shown in requests table below
  ['ts', 'sku', 'title', 'amount', 'payer'],
  store.recentSales().map((s) => [s.ts, s.sku, s.title, s.amountUsdc, s.payer]),
)}

<h2>Requests</h2>
<div class="tile">Conversion — paid: ${escapeHtml(conv.paid)}, unpaid: ${escapeHtml(conv.unpaid)}, ratio: ${escapeHtml(conv.ratio === null ? 'n/a' : conv.ratio.toFixed(2))}</div>
${table(
  ['ts', 'method', 'path', 'outcome', 'ip hash', 'tx hash', 'user agent'],
  store.recentRequests().map((r) => [r.ts, r.method, r.path, r.outcome, r.ipHash ?? '', r.txHash ?? '', r.userAgent ?? '']),
)}
</body></html>`;
    return c.html(html);
  });

  return app;
}
