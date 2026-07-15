/** Shared design system for every server-rendered surface (store, feed, admin, files).
 *  Self-contained: system fonts, no CDN, light/dark via prefers-color-scheme. */

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const CSS = `
:root{
  --bg:#f6f7f9; --surface:#ffffff; --surface-2:#eef0f4;
  --ink:#16181d; --ink-2:#5a6272; --ink-3:#8b93a5;
  --line:#e3e6ec; --accent:#4f46e5; --accent-ink:#ffffff; --accent-soft:#eef0ff;
  --good:#0f7b3e; --good-soft:#e5f5ec; --warn:#8a5a00; --warn-soft:#fdf3dd; --bad:#b3261e; --bad-soft:#fceeed;
  --radius:12px; --shadow:0 1px 2px rgb(22 24 29 / .06), 0 4px 16px rgb(22 24 29 / .05);
}
@media (prefers-color-scheme: dark){:root{
  --bg:#101216; --surface:#181b21; --surface-2:#22262e;
  --ink:#e8eaf0; --ink-2:#a6adbd; --ink-3:#7a8294;
  --line:#2a2f38; --accent:#818cf8; --accent-ink:#101216; --accent-soft:#232647;
  --good:#4ade80; --good-soft:#12291b; --warn:#fbbf24; --warn-soft:#2d2410; --bad:#f87171; --bad-soft:#2e1615;
  --shadow:0 1px 2px rgb(0 0 0 / .4);
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--line);z-index:10}
header .in{max-width:920px;margin:0 auto;padding:.7rem 1.25rem;display:flex;gap:1.25rem;align-items:center}
.brand{font-weight:750;letter-spacing:-.01em;color:var(--ink);margin-right:auto;display:flex;gap:.55rem;align-items:center}
.brand .dot{width:.65rem;height:.65rem;border-radius:50%;background:var(--accent);display:inline-block}
header a.nav{color:var(--ink-2);font-weight:550;padding:.25rem .6rem;border-radius:8px}
header a.nav:hover{background:var(--surface-2);color:var(--ink);text-decoration:none}
main{max-width:920px;margin:0 auto;padding:1.75rem 1.25rem 4rem}
h1{font-size:1.45rem;letter-spacing:-.02em;margin:.2rem 0 .4rem}
h2{font-size:1.05rem;margin:2rem 0 .75rem;color:var(--ink)}
.lede{color:var(--ink-2);margin:0 0 1.5rem}
.muted{color:var(--ink-3)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:1.1rem 1.3rem;margin-bottom:1.1rem}
.card h2{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin:0 0 .3rem;font-size:1.1rem}
.price{font-size:.8rem;font-weight:650;background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:.18rem .7rem;white-space:nowrap}
.desc{margin:.15rem 0 .6rem;color:var(--ink-2)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th{text-align:left;color:var(--ink-3);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;padding:.45rem .6rem;border-bottom:1px solid var(--line)}
td{padding:.5rem .6rem;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--surface-2)}
td.size,td.num{text-align:right;color:var(--ink-3);white-space:nowrap;font-variant-numeric:tabular-nums}
.excerpt{color:var(--ink-3);font-style:italic;font-size:.85rem;margin:.15rem 0 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.9rem;margin:.9rem 0 1.4rem}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:.9rem 1.1rem}
.tile .v{font-size:1.55rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile .k{color:var(--ink-3);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.15rem}
.badge{font-size:.75rem;font-weight:650;border-radius:999px;padding:.12rem .55rem;white-space:nowrap}
.badge.good{background:var(--good-soft);color:var(--good)}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.badge.bad{background:var(--bad-soft);color:var(--bad)}
.badge.plain{background:var(--surface-2);color:var(--ink-2)}
button,.btn{font:inherit;font-weight:600;background:var(--accent);color:var(--accent-ink);border:none;border-radius:9px;padding:.45rem .95rem;cursor:pointer}
button:hover,.btn:hover{filter:brightness(1.08)}
button.danger{background:transparent;color:var(--bad);border:1px solid var(--line);padding:.25rem .7rem}
button.danger:hover{background:var(--bad-soft);filter:none}
input,select{font:inherit;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:.45rem .7rem}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
form.panel{background:var(--surface);border:1px dashed var(--line);border-radius:var(--radius);padding:1rem 1.2rem;margin:1rem 0;display:flex;gap:.8rem;align-items:center;flex-wrap:wrap}
form.stack{display:grid;gap:.7rem;max-width:28rem}
form.stack label{display:grid;gap:.25rem;font-weight:600;font-size:.85rem;color:var(--ink-2)}
footer{color:var(--ink-3);font-size:.8rem;max-width:920px;margin:0 auto;padding:0 1.25rem 2rem}
.wrap{overflow-x:auto}
`;

export interface PageOpts {
  active?: "store" | "sales" | "admin";
  admin?: boolean; // adds the Admin nav link (only rendered on admin-side pages)
}

export function page(title: string, body: string, opts: PageOpts = {}): string {
  const nav = [
    ["/catalog", "Store", "store"],
    ["/feed", "Sales", "sales"],
    ...(opts.admin ? [["/admin", "Admin", "admin"]] : []),
  ]
    .map(([href, label]) => `<a class="nav" href="${href}">${label}</a>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>
<header><div class="in"><span class="brand"><span class="dot"></span>x402 sandbox</span>${nav}</div></header>
<main>${body}</main>
<footer>Powered by <a href="https://x402.org">x402</a> — pay-per-request over HTTP. USDC settles to the operator's own wallet.</footer>
</body></html>`;
}
