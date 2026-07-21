import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { EnvConfig, ProductConfig } from "./config.js";

interface PaymentOption {
  scheme: "exact";
  payTo: string;
  price: string | number;
  network: string;
}

interface RouteConfigEntry {
  accepts: PaymentOption[];
  description?: string;
  mimeType?: string;
  resource?: string;
  extensions?: Record<string, unknown>;
}

export type RoutesConfig = Record<string, RouteConfigEntry>;

export type PriceOverrides = Map<string, { current: string; previous?: string }>;

/** Effective price: fixed price, or for demand products the live override
 *  (falling back to the floor before the first repricing pass). */
function effectivePrice(p: ProductConfig, overrides?: PriceOverrides): { current: string | number; previous?: string } {
  const o = overrides?.get(p.sku);
  if (o) return { current: `$${o.current}`, ...(o.previous ? { previous: `$${o.previous}` } : {}) };
  if (p.pricing) return { current: p.pricing.floor };
  return { current: p.price! };
}

/** Maps validated products → @x402/hono RoutesConfig. payTo and scheme come
 *  from env, never the catalog; discoverable lives under extensions (not
 *  first-class in v2). During a repricing grace window the previous price is
 *  kept as a second accepted option so in-flight 402 quotes still verify. */
export function buildRoutes(
  products: ProductConfig[],
  env: EnvConfig,
  overrides?: PriceOverrides,
): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const p of products) {
    if (routes[p.route]) throw new Error(`duplicate route "${p.route}" (sku ${p.sku})`);
    const network = p.network ?? env.network;
    const price = effectivePrice(p, overrides);
    const accepts: PaymentOption[] = [{ scheme: "exact", payTo: env.payTo, price: price.current, network }];
    if (price.previous) accepts.push({ scheme: "exact", payTo: env.payTo, price: price.previous, network });
    const entry: RouteConfigEntry = { accepts };
    if (p.description !== undefined) {
      // CDP's facilitator schema rejects payment payloads whose resource.description
      // exceeds ~256 chars (verified empirically 2026-07-16). The storefront still
      // shows the full text; only the protocol metadata is capped.
      entry.description = p.description.length > 250 ? `${p.description.slice(0, 249)}…` : p.description;
    }
    if (p.mimeType !== undefined) entry.mimeType = p.mimeType;
    if (p.discoverable || p.extensions) {
      // discoverable products get a real bazaar declaration (operator-supplied one wins)
      // the published .d.ts omits `method`, but the runtime builder (and their docs) use it
      const auto = p.discoverable ? declareDiscoveryExtension({ method: "GET" } as never) : {};
      entry.extensions = { ...auto, ...p.extensions, ...(p.discoverable ? { discoverable: true } : {}) };
    }
    // A canonical https resource fixes the mixed-content retry (BUILDLOG) — BUT it also
    // drops the query string. Parameterized products (humanForm) carry their inputs in the
    // query and must sign/retry the LIVE url, so skip the override for them; proxyAwareFetch
    // already upgrades their url to https, so getUrl() stays mixed-content-safe.
    if (env.publicOrigin && !p.route.endsWith("/*") && !p.humanForm) {
      entry.resource = `${env.publicOrigin}${p.route.slice(p.route.indexOf(" ") + 1)}`;
    }
    routes[p.route] = entry;
  }
  return routes;
}
