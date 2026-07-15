import type { DemandPricing, ProductConfig } from "./config.js";
import type { Store } from "./db.js";

const money = (v: string) => Number(v.slice(1));
const round6 = (n: number) => Number(n.toFixed(6)); // USDC has 6 decimals

/** Pure bounded policy: quiet window decays toward floor, purchases step toward ceiling. */
export function nextPrice(current: number, purchasesInWindow: number, p: DemandPricing): number {
  const next = purchasesInWindow > 0 ? current * (1 + p.step) : current * (1 - p.step);
  return round6(Math.min(money(p.ceiling), Math.max(money(p.floor), next)));
}

export interface PriceChange {
  sku: string;
  previous: string;
  current: string;
}

/** One repricing pass over demand-priced products. Reads the sales window from
 *  settlements, persists the new price in the products table, reports changes. */
export function repriceOnce(store: Store, products: ProductConfig[]): PriceChange[] {
  const changes: PriceChange[] = [];
  for (const p of products) {
    if (!p.pricing) continue;
    const row = store.productBySku(p.sku);
    if (!row) continue;
    const since = new Date(Date.now() - p.pricing.windowMinutes * 60_000).toISOString();
    const sales = store.salesCountSince(row.id, since);
    const next = nextPrice(Number(row.priceUsdc), sales, p.pricing);
    const current = String(next);
    if (current !== row.priceUsdc) {
      store.setPrice(p.sku, current);
      changes.push({ sku: p.sku, previous: row.priceUsdc, current });
    }
  }
  return changes;
}

/** Interval driver; returns a stop function. onChange receives the grace map for
 *  the routes rebuild (current + previous accepted for one window). */
export function startRepricer(
  store: Store,
  products: () => ProductConfig[],
  onChange: (grace: Map<string, { current: string; previous?: string }>) => void,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    const changes = repriceOnce(store, products());
    if (changes.length) {
      onChange(new Map(changes.map((c) => [c.sku, { current: c.current, previous: c.previous }])));
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
