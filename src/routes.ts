import type { EnvConfig, ProductConfig } from "./config.js";

interface RouteConfigEntry {
  accepts: Array<{ scheme: "exact"; payTo: string; price: string | number; network: string }>;
  description?: string;
  mimeType?: string;
  extensions?: Record<string, unknown>;
}

export type RoutesConfig = Record<string, RouteConfigEntry>;

/** Maps validated products → @x402/hono RoutesConfig. payTo and scheme come
 *  from env, never the catalog; discoverable lives under extensions (not
 *  first-class in v2). */
export function buildRoutes(products: ProductConfig[], env: EnvConfig): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const p of products) {
    if (routes[p.route]) throw new Error(`duplicate route "${p.route}" (sku ${p.sku})`);
    const entry: RouteConfigEntry = {
      accepts: [
        { scheme: "exact", payTo: env.payTo, price: p.price, network: p.network ?? env.network },
      ],
    };
    if (p.description !== undefined) entry.description = p.description;
    if (p.mimeType !== undefined) entry.mimeType = p.mimeType;
    if (p.discoverable || p.extensions) {
      entry.extensions = { ...p.extensions, ...(p.discoverable ? { discoverable: true } : {}) };
    }
    routes[p.route] = entry;
  }
  return routes;
}
