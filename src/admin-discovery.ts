import { Hono } from "hono";
import type { ProductConfig } from "./config.js";
import { escapeHtml, page } from "./ui.js";

interface DiscoveryItem {
  resource: string;
  accepts: Array<{ payTo: string }>;
  lastUpdated: string;
}

export interface DiscoveryDeps {
  products(): ProductConfig[];
  payTo: string;
  publicOrigin?: string;
  /** Queries the facilitator's Bazaar discovery index (withBazaar client). */
  list(): Promise<{ items: DiscoveryItem[] }>;
}

/** Confirms listings: pulls the facilitator's discovery index and matches it
 *  against our catalog by payTo and public origin. Mounted under the admin gate. */
export function adminDiscovery(deps: DiscoveryDeps): Hono {
  const app = new Hono();

  app.get("/discovery", async (c) => {
    let items: DiscoveryItem[] = [];
    let error: string | undefined;
    try {
      items = (await deps.list()).items ?? [];
    } catch (err) {
      error = (err as Error).message;
    }
    const mine = items.filter(
      (i) =>
        i.accepts?.some((a) => a.payTo?.toLowerCase() === deps.payTo.toLowerCase()) ||
        (deps.publicOrigin && i.resource?.startsWith(deps.publicOrigin)),
    );

    const routePath = (p: ProductConfig) => p.route.slice(p.route.indexOf(" ") + 1).replace(/\/\*$/, "/");
    const rows = deps
      .products()
      .map((p) => {
        if (!p.discoverable) {
          return `<tr><td>${escapeHtml(p.sku)}</td><td><span class="badge plain">discovery off</span></td><td class="muted">enable in edit</td></tr>`;
        }
        const hit = mine.find((i) => i.resource?.includes(routePath(p)));
        return hit
          ? `<tr><td>${escapeHtml(p.sku)}</td><td><span class="badge good">listed</span></td><td class="muted">registry updated ${escapeHtml(hit.lastUpdated?.slice(0, 10) ?? "")}</td></tr>`
          : `<tr><td>${escapeHtml(p.sku)}</td><td><span class="badge warn">not yet listed</span></td><td class="muted">announced on payment traffic — see notes below</td></tr>`;
      })
      .join("");

    const body = `
<h1>Discovery</h1>
<p class="lede"><a href="/admin">← Admin</a> · checks the facilitator's Bazaar index live: which of your products AI agents can find without knowing your URL.</p>
${error ? `<div class="card" style="border-color:var(--warn)"><span class="badge warn">registry unreachable</span> ${escapeHtml(error)}</div>` : ""}
<div class="card wrap"><table><thead><tr><th>product</th><th>status</th><th></th></tr></thead><tbody>${rows || '<tr><td class="muted" colspan="3">no products</td></tr>'}</tbody></table></div>
<div class="card">
<h2>How listing works</h2>
<ul>
<li>Your own <code>/catalog.json</code> always lists everything — agents that know your URL need nothing else.</li>
<li><strong>Bazaar</strong> (the facilitator's index) lists products with discovery enabled. The index learns about resources from their x402 traffic through the facilitator, so a brand-new product typically appears after its first real payment challenges — not instantly.</li>
<li>Chain explorers (x402scan and similar) discover sellers from on-chain settlements independently — no action needed.</li>
<li>${deps.publicOrigin ? `Announced URLs use <code>${escapeHtml(deps.publicOrigin)}</code>.` : `<span class="badge warn">PUBLIC_ORIGIN not set</span> — without it, announced resource URLs may use localhost and be useless to agents. Set it in <code>.env</code>.`}</li>
</ul>
</div>`;
    return c.html(page("Discovery", body, { admin: true }));
  });

  return app;
}
