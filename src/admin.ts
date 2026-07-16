import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { ProductRow, Store } from "./db.js";
import { escapeHtml as esc, page } from "./ui.js";

function escapeHtml(s: unknown): string {
  return esc(String(s ?? "")).replaceAll("'", "&#39;");
}

function kind(p: ProductRow): string {
  return p.bundlePath ? "bundle" : p.contentDir ? "dir" : "file";
}

function table(headers: string[], rows: unknown[][], numericFrom?: number): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${r
              .map((c, i) => `<td${numericFrom !== undefined && i >= numericFrom ? ' class="num"' : ""}>${escapeHtml(c)}</td>`)
              .join("")}</tr>`,
        )
        .join("")
    : `<tr><td colspan="${headers.length}" class="muted">none yet</td></tr>`;
  return `<div class="card wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function tile(value: string, label: string): string {
  return `<div class="tile"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value)}</div></div>`;
}

const OUTCOME_BADGE: Record<string, string> = {
  paid_200: "good",
  free_200: "plain",
  unpaid_402: "warn",
  not_found: "plain",
  error: "bad",
};

function outcomeBadge(outcome: string): string {
  return `<span class="badge ${OUTCOME_BADGE[outcome] ?? "plain"}">${escapeHtml(outcome)}</span>`;
}

const LOCKOUT_FAILS = 5;
const LOCKOUT_MS = 15 * 60_000;

/** Read-only admin stats app, mounted by the server at /admin. */
export function adminApp(store: Store, adminPassword: string, network: string): Hono {
  const app = new Hono();

  // Brute-force lockout: 5 failed logins from one source → 429 for 15 minutes.
  // In-memory is right here: a restart clearing it only helps the operator.
  const attempts = new Map<string, { count: number; lockedUntil: number }>();
  app.use("*", async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const entry = attempts.get(ip);
    const now = Date.now();
    if (entry && entry.lockedUntil > now) {
      return c.text("Too many failed logins — locked out for 15 minutes.", 429);
    }
    const recordFailure = () => {
      const expired = entry !== undefined && entry.lockedUntil !== 0 && entry.lockedUntil <= now;
      const count = (expired ? 0 : (entry?.count ?? 0)) + 1;
      const lockedUntil = count >= LOCKOUT_FAILS ? now + LOCKOUT_MS : 0;
      attempts.set(ip, { count, lockedUntil });
      if (lockedUntil) console.warn(`[admin-audit] ${new Date().toISOString()} lockout ${ip} (${count} failures)`);
      if (attempts.size > 1000) {
        for (const [k, v] of attempts) if (v.lockedUntil <= now) attempts.delete(k); // ponytail: crude prune
      }
    };
    try {
      await next();
    } catch (err) {
      // hono's basicAuth THROWS an HTTPException on bad credentials
      if ((err as { status?: number }).status === 401) recordFailure();
      throw err;
    }
    if (c.res.status === 401) recordFailure();
    else if (c.res.status < 400) attempts.delete(ip);
  });

  app.use("*", basicAuth({ username: "admin", password: adminPassword }));

  app.get("/", (c) => {
    const totals = store.totals(network);
    const conv = store.conversion();
    const products = store.activeProducts();

    const productRows = products.length
      ? products
          .map(
            (p) =>
              `<tr><td>${escapeHtml(p.sku)}</td><td>${escapeHtml(p.title)}</td><td class="num">$${escapeHtml(p.priceUsdc)}</td><td><span class="badge plain">${escapeHtml(kind(p))}</span></td><td>${escapeHtml(p.network)}</td><td><a href="/admin/products/${encodeURIComponent(p.sku)}/edit">edit</a>${p.contentDir ? ` · <a href="/admin/files/${encodeURIComponent(p.sku)}">files</a>` : ""} <form method="post" action="/admin/products/${encodeURIComponent(p.sku)}/delete" style="display:inline" onsubmit="return confirm('Remove ${escapeHtml(p.sku)} from the store? Its files stay on disk.')"><button class="danger">remove</button></form></td></tr>`,
          )
          .join("")
      : '<tr><td colspan="6" class="muted">none yet</td></tr>';

    const requestRows = store
      .recentRequests()
      .map(
        (r) =>
          `<tr><td class="muted">${escapeHtml(r.ts.slice(0, 19).replace("T", " "))}</td><td>${escapeHtml(r.method)}</td><td>${escapeHtml(r.path)}</td><td>${outcomeBadge(r.outcome)}</td><td class="muted" title="${escapeHtml(r.txHash ?? "")}">${escapeHtml((r.txHash ?? "").slice(0, 12))}</td><td class="muted">${escapeHtml((r.userAgent ?? "").slice(0, 40))}</td></tr>`,
      )
      .join("");

    const body = `
<h1>Admin</h1>
<p class="lede">Operator view — full payer addresses and traffic stay behind this login.</p>
<p style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap"><a class="btn" href="/admin/products/new">+ Add product</a> <a href="/admin/settings" title="Settings" style="font-size:1.25rem;line-height:1;text-decoration:none">⚙</a> <a href="/admin/discovery">Discovery</a> <a href="/admin/export/sales.csv">Export sales CSV</a></p>

<div class="tiles">
  ${tile(`$${totals.totalUsdc.toFixed(2)}`, "revenue")}
  ${tile(String(totals.saleCount), "sales")}
  ${tile(String(conv.paid), "paid hits")}
  ${tile(String(conv.unpaid), "unpaid hits")}
  ${tile(conv.ratio === null ? "n/a" : conv.ratio.toFixed(2), "conversion ratio")}
</div>

<h2>Products</h2>
<div class="card wrap"><table><thead><tr><th>sku</th><th>title</th><th>price</th><th>kind</th><th>network</th><th>actions</th></tr></thead><tbody>${productRows}</tbody></table></div>

<h2>Sales — last 7 days</h2>
${table(["day", "earnings", "sales"], store.daily(7).map((d) => [d.day, d.earnings.toFixed(2), d.sales]), 1)}

<h2>Top products</h2>
${table(["sku", "title", "sales", "revenue"], store.topProducts().map((t) => [t.sku, t.title, t.sales, t.revenue.toFixed(2)]), 2)}

<h2>Recent sales</h2>
${table(["ts", "sku", "title", "amount", "payer"], store.recentSales().map((s) => [s.ts, s.sku, s.title, s.amountUsdc, s.payer]))}

<h2>Requests</h2>
<div class="card wrap"><table><thead><tr><th>ts</th><th>method</th><th>path</th><th>outcome</th><th>tx</th><th>user agent</th></tr></thead><tbody>${requestRows || '<tr><td colspan="6" class="muted">none yet</td></tr>'}</tbody></table></div>`;

    return c.html(page("Admin", body, { admin: true, active: "admin" }));
  });

  return app;
}
