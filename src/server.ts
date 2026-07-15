import { existsSync, readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { createPaywall, evmPaywall } from "@x402/paywall";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { loadEnv, loadProducts, type EnvConfig, type ProductConfig } from "./config.js";
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

export interface AppHandle {
  app: Hono;
  /** Re-reads products.json and swaps the payment middleware in place.
   *  A broken catalog logs a warning and keeps the old one serving. */
  reload(): void;
  /** Fetches supported payment kinds from the facilitator. Must resolve once
   *  before paid routes can issue 402 challenges. */
  init(): Promise<void>;
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

function toStoreProducts(products: ProductConfig[], env: EnvConfig) {
  return products.map((p) => ({
    sku: p.sku,
    title: p.title,
    description: p.description,
    price: p.price,
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

  const buildPaid = (products: ProductConfig[]) =>
    // syncFacilitatorOnStart=false: no network call at construction (reload-safe)
    paymentMiddleware(buildRoutes(products, env) as never, resourceServer, paywallConfig, paywall, false);

  let products = loadProducts(readFileSync(productsPath, "utf8"), baseDir);
  let paid = buildPaid(products);
  store.syncProducts(toStoreProducts(products, env));

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
  app.route("/admin", adminApp(store, env.adminPassword, env.network));

  // 404 BEFORE 402: a buyer must never pay for a file that doesn't exist.
  app.use(precheck404(deps));
  // Indirection so reload() can swap the middleware without re-mounting.
  app.use((c, next) => paid(c, next));
  app.all("*", paidContent(deps));

  const reload = () => {
    try {
      const next = loadProducts(readFileSync(productsPath, "utf8"), baseDir);
      paid = buildPaid(next);
      products = next;
      store.syncProducts(toStoreProducts(next, env));
      console.log(`catalog reloaded: ${next.length} product(s)`);
    } catch (err) {
      console.warn(`catalog reload failed, keeping previous catalog: ${(err as Error).message}`);
    }
  };

  return { app, reload, init: () => resourceServer.initialize() };
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = loadEnv();
  const baseDir = process.cwd();
  const productsPath = resolve(baseDir, process.env.PRODUCTS_PATH ?? "products.json");
  const store = new Store(env.dbPath);
  const { app, reload, init } = createApp({ env, store, baseDir, productsPath });
  await init(); // fail fast if the facilitator is unreachable or unsupported

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
