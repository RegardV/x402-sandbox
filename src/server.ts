import { existsSync, readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { createPaywall, evmPaywall } from "@x402/paywall";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { loadEnv, loadProducts, type EnvConfig, type ProductConfig } from "./config.js";
import { assertNotDevWalletOnMainnet } from "./provision.js";
import { Store } from "./db.js";
import { buildRoutes } from "./routes.js";
import { requestLogger } from "./request-logger.js";
import {
  catalogHtml,
  catalogJson,
  feedPage,
  matchProduct,
  paidContent,
  precheck404,
  type HandlerDeps,
} from "./handlers.js";
import { adminApp } from "./admin.js";
import { adminCrud } from "./admin-crud.js";
import { adminFiles } from "./admin-files.js";
import { startRepricer } from "./pricing.js";
import type { PriceOverrides } from "./routes.js";

export interface AppHandle {
  app: Hono;
  /** Re-reads products.json and swaps the payment middleware in place.
   *  A broken catalog logs a warning and keeps the old one serving. */
  reload(): void;
  /** Fetches supported payment kinds from the facilitator. Must resolve once
   *  before paid routes can issue 402 challenges. */
  init(): Promise<void>;
  /** Current validated catalog. */
  products(): ProductConfig[];
  /** Swap the payment middleware, optionally with a repricing grace window. */
  rebuild(grace?: PriceOverrides): void;
}

/** The one method x402ResourceServer.initialize() needs — lets tests stub the facilitator. */
export interface FacilitatorClientLike {
  getSupported(): Promise<{ kinds: Array<Record<string, unknown>> }>;
}

export interface CreateAppOptions {
  env: EnvConfig;
  store: Store;
  baseDir: string;
  productsPath: string;
  facilitatorClient?: FacilitatorClientLike;
}

function toStoreProducts(products: ProductConfig[], env: EnvConfig, store: Store) {
  return products.map((p) => ({
    sku: p.sku,
    title: p.title,
    description: p.description,
    // demand products keep their live repriced value across catalog syncs
    price: p.pricing ? `$${store.productBySku(p.sku)?.priceUsdc ?? p.pricing.floor.slice(1)}` : p.price!,
    network: p.network ?? env.network,
    contentPath: p.contentPath,
    bundlePath: p.bundlePath,
    contentDir: p.contentDir,
    mimeType: p.mimeType,
    discoverable: p.discoverable,
  }));
}

export function createApp(opts: CreateAppOptions): AppHandle {
  const { env, store, baseDir, productsPath } = opts;

  const facilitator =
    opts.facilitatorClient ?? new HTTPFacilitatorClient({ url: env.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator as never);
  registerExactEvmScheme(resourceServer);

  const paywallConfig = { appName: "x402 sandbox", testnet: env.network === "eip155:84532" };
  const paywall = createPaywall().withNetwork(evmPaywall).withConfig(paywallConfig).build();

  let products = loadProducts(readFileSync(productsPath, "utf8"), baseDir);
  store.syncProducts(toStoreProducts(products, env, store));

  /** Live prices for demand products from the DB, merged with a repricing grace window. */
  const demandOverrides = (grace?: PriceOverrides): PriceOverrides => {
    const m: PriceOverrides = new Map();
    for (const p of products) {
      if (!p.pricing) continue;
      const g = grace?.get(p.sku);
      const current = g?.current ?? store.productBySku(p.sku)?.priceUsdc ?? p.pricing.floor.slice(1);
      m.set(p.sku, { current, ...(g?.previous ? { previous: g.previous } : {}) });
    }
    return m;
  };

  const buildPaid = (products: ProductConfig[], grace?: PriceOverrides) =>
    // syncFacilitatorOnStart=false: no network call at construction (reload-safe)
    paymentMiddleware(
      buildRoutes(products, env, demandOverrides(grace)) as never,
      resourceServer,
      paywallConfig,
      paywall,
      false,
    );

  let paid = buildPaid(products);

  const deps: HandlerDeps = { store, products: () => products, baseDir };

  const app = new Hono();
  app.use(
    requestLogger({
      store,
      ipSalt: env.ipSalt,
      matchProduct(method, path) {
        const p = matchProduct(products, method, path);
        if (!p) return undefined;
        const row = store.productBySku(p.sku);
        return row ? { id: row.id, priceUsdc: row.priceUsdc } : undefined;
      },
    }),
  );

  // Free surfaces — registered before the payment layer, never gated.
  app.get("/catalog", catalogHtml(deps));
  app.get("/catalog.json", catalogJson(deps));
  app.get("/feed", feedPage(deps));
  const admin = adminApp(store, env.adminPassword, env.network);
  admin.route("/", adminCrud({ store, productsPath, baseDir, onCatalogChange: () => reload() }));
  admin.route("/", adminFiles({ products: () => products }));
  app.route("/admin", admin);

  // 404 BEFORE 402: a buyer must never pay for a file that doesn't exist.
  app.use(precheck404(deps));
  // Indirection so reload() can swap the middleware without re-mounting.
  app.use((c, next) => paid(c, next));
  app.all("*", paidContent(deps));

  const reload = () => {
    try {
      const next = loadProducts(readFileSync(productsPath, "utf8"), baseDir);
      store.syncProducts(toStoreProducts(next, env, store));
      paid = buildPaid(next);
      products = next;
      console.log(`catalog reloaded: ${next.length} product(s)`);
    } catch (err) {
      console.warn(`catalog reload failed, keeping previous catalog: ${(err as Error).message}`);
    }
  };

  return {
    app,
    reload,
    init: () => resourceServer.initialize(),
    products: () => products,
    rebuild: (grace?: PriceOverrides) => {
      paid = buildPaid(products, grace);
    },
  };
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = loadEnv();
  const baseDir = process.cwd();
  assertNotDevWalletOnMainnet(baseDir, env.network, env.payTo); // a generated key never receives real funds
  const productsPath = resolve(baseDir, process.env.PRODUCTS_PATH ?? "products.json");
  const store = new Store(env.dbPath);
  const handle = createApp({ env, store, baseDir, productsPath });
  const { app, reload, init } = handle;
  await init(); // fail fast if the facilitator is unreachable or unsupported

  const windows = handle.products().flatMap((p) => (p.pricing ? [p.pricing.windowMinutes] : []));
  if (windows.length) {
    const windowMs = Math.min(...windows) * 60_000;
    startRepricer(
      store,
      handle.products,
      (grace) => {
        handle.rebuild(grace); // old + new price both accepted…
        setTimeout(() => handle.rebuild(), windowMs).unref(); // …until the grace window closes
        console.log(`repriced: ${[...grace.entries()].map(([s, g]) => `${s}→$${g.current}`).join(", ")}`);
      },
      windowMs,
    );
    console.log(`demand repricer active (${windows.length} product(s), window ${windowMs / 60000}m)`);
  }

  let timer: NodeJS.Timeout | undefined;
  watch(productsPath, () => {
    clearTimeout(timer);
    timer = setTimeout(reload, 300); // fs.watch fires in bursts; debounce
  });

  serve({ fetch: app.fetch, port: env.port, hostname: "127.0.0.1" });
  console.log(`x402-sandbox on http://127.0.0.1:${env.port} (network ${env.network})`);
  console.log(`catalog: /catalog  feed: /feed  admin: /admin (user "admin")`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
