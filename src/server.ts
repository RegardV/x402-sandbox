import { existsSync, readFileSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { createPaywall, evmPaywall } from "@x402/paywall";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { loadEnv, loadProducts, type EnvConfig, type ProductConfig } from "./config.js";
import { assertNotDevWalletOnMainnet } from "./provision.js";
import { Store } from "./db.js";
import { buildRoutes } from "./routes.js";
import { hashIp, requestLogger } from "./request-logger.js";
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
import { settingsRoutes } from "./settings.js";
import { adminDiscovery } from "./admin-discovery.js";
import { withBazaar } from "@x402/extensions/bazaar";
import { docsRoutes } from "./docs.js";
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
  /** Wired by main(): gracefully stop listening, respawn, exit. Enables the settings restart button. */
  onRestart?: () => void;
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

/** Testnet: plain URL client (x402.org, no auth). Mainnet: Coinbase CDP facilitator,
 *  authenticated via CDP_API_KEY_ID/SECRET (createFacilitatorConfig wraps them). */
function buildFacilitatorClient(env: EnvConfig): HTTPFacilitatorClient {
  const client =
    env.network === "eip155:8453"
      ? process.env.FACILITATOR_URL_MAINNET // escape hatch: a non-CDP mainnet facilitator
        ? new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL_MAINNET })
        : new HTTPFacilitatorClient(createFacilitatorConfig(env.cdpApiKeyId!, env.cdpApiKeySecret!) as never)
      : new HTTPFacilitatorClient({ url: env.facilitatorUrl });
  if (process.env.PAYMENT_DEBUG === "1") {
    const orig = client.verify.bind(client);
    (client as { verify: typeof client.verify }).verify = async (payload: never, requirements: never) => {
      console.log(`[payment] → verify request body: ${JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements })}`);
      return orig(payload, requirements);
    };
  }
  return client;
}

export function createApp(opts: CreateAppOptions): AppHandle {
  const { env, store, baseDir, productsPath } = opts;

  const facilitator = opts.facilitatorClient ?? buildFacilitatorClient(env);
  const resourceServer = new x402ResourceServer(facilitator as never);
  registerExactEvmScheme(resourceServer);
  // Payment failures are invisible without these — log the thrown error, not the payload dump.
  const paymentFailure = (stage: string) => (ctx: unknown) => {
    const { error, paymentPayload } = ctx as {
      error?: Error & { cause?: unknown; response?: unknown };
      paymentPayload?: { payload?: { authorization?: { from?: string } } };
    };
    console.warn(
      `[payment] ${stage} FAILED from=${paymentPayload?.payload?.authorization?.from ?? "?"} error=${String(error)} cause=${JSON.stringify(error?.cause ?? null)} response=${JSON.stringify(error?.response ?? null)?.slice(0, 800)}`,
    );
  };
  (resourceServer as never as { onVerifyFailure(h: (ctx: unknown) => void): void }).onVerifyFailure(paymentFailure("verify"));
  (resourceServer as never as { onSettleFailure(h: (ctx: unknown) => void): void }).onSettleFailure(paymentFailure("settle"));

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
  app.get("/", (c) => c.redirect("/catalog", 302));
  app.get("/catalog", catalogHtml(deps));
  app.get("/catalog.json", catalogJson(deps));
  app.get("/feed", feedPage(deps));
  app.route("/", docsRoutes());
  const admin = adminApp(store, env.adminPassword, env.network);
  admin.route("/", adminCrud({ store, productsPath, baseDir, onCatalogChange: () => reload() }));
  admin.route("/", adminFiles({ products: () => products, store }));
  admin.route("/", settingsRoutes(baseDir, env, opts.onRestart));
  admin.route(
    "/",
    adminDiscovery({
      products: () => products,
      payTo: env.payTo,
      publicOrigin: env.publicOrigin,
      list: () => (withBazaar(facilitator as never) as never as { extensions: { bazaar: { listResources(): Promise<{ items: never[] }> } } }).extensions.bazaar.listResources(),
    }),
  );
  app.route("/admin", admin);

  // Paid paths must never be edge-cached (a cached 402 breaks buying; a cached 200 leaks content).
  app.use(async (c, next) => {
    await next();
    if (matchProduct(products, c.req.method, c.req.path)) c.res.headers.set("cache-control", "no-store");
  });
  // 404 BEFORE 402: a buyer must never pay for a file that doesn't exist.
  app.use(precheck404(deps));
  // HEAD probes and paid-but-not-delivered redelivery — both before the payment wall.
  const redeliveryMinutes = Number(process.env.REDELIVERY_MINUTES ?? 60);
  app.use(async (c, next) => {
    const p = matchProduct(products, c.req.method, c.req.path);
    if (!p) return next();
    if (c.req.method === "HEAD") return c.body(null, 200); // existence probe: headers only, no payment
    if (!c.req.header("x-payment") && !c.req.header("payment-signature")) {
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const grant = store.findRedeliveryGrant(c.req.path, hashIp(ip, env.ipSalt), redeliveryMinutes);
      if (grant) {
        // Same source already paid for exactly this URL within the window — deliver, don't re-charge.
        console.log(`[payment] redelivery for ${c.req.path} (tx ${grant.txHash?.slice(0, 12)})`);
        c.header("x-redelivery", "1");
        return paidContent(deps)(c, next as never) as Promise<Response>;
      }
    }
    await next();
  });
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

/** Cloudflared terminates TLS and forwards plain HTTP; without this the SDK
 *  builds http:// resource URLs that HTTPS paywall pages can't fetch (mixed content). */
export function proxyAwareFetch(app: Hono): (req: Request) => Response | Promise<Response> {
  return (req) => {
    if (req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http://")) {
      return app.fetch(new Request(`https://${req.url.slice(7)}`, req));
    }
    return app.fetch(req);
  };
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = loadEnv();
  const baseDir = process.cwd();
  assertNotDevWalletOnMainnet(baseDir, env.network, env.payTo); // a generated key never receives real funds
  const productsPath = resolve(baseDir, process.env.PRODUCTS_PATH ?? "products.json");
  const store = new Store(env.dbPath);
  // Self-restart: stop accepting connections, respawn detached, exit. The child's
  // environment is stripped of all config keys so process.loadEnvFile re-reads .env
  // fresh (loadEnvFile never overrides variables that already exist).
  const CONFIG_KEYS = ["PAY_TO", "PAY_TO_TESTNET", "PAY_TO_MAINNET", "NETWORK", "FACILITATOR_URL",
    "ADMIN_PASSWORD", "IP_SALT", "PORT", "DB_PATH", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET"];
  const onRestart = () => {
    // Under systemd (INVOCATION_ID set), Restart=always owns respawning — a
    // self-spawned child would escape the cgroup and leave TWO servers running.
    if (process.env.INVOCATION_ID) {
      srv.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
      return;
    }
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !CONFIG_KEYS.includes(k)),
    ) as NodeJS.ProcessEnv;
    srv.close(() => {
      // tsx rewrites argv[1] to the .ts entry itself — re-attach the loader explicitly
      const child = spawn(process.execPath, ["--import", "tsx", ...process.argv.slice(1)], {
        cwd: baseDir, env: childEnv, detached: true, stdio: "inherit",
      });
      child.unref();
      console.log("restarting: handed off to new process");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref(); // close() hangs on open keep-alives — hard exit fallback
  };
  const handle = createApp({ env, store, baseDir, productsPath, onRestart });
  const { app, reload, init } = handle;
  // Transient network blips at boot are common (observed twice today) — retry with
  // backoff before giving up; a genuinely bad facilitator config still fails within ~1 min.
  const delays = [2000, 4000, 8000, 16000, 30000];
  for (let attempt = 0; ; attempt++) {
    try {
      await init();
      break;
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined) throw err;
      console.warn(`facilitator init failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delay / 1000}s: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

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

  // Privacy retention: purge traffic rows daily (settlements ledger is never trimmed).
  const retentionDays = Number(process.env.RETENTION_DAYS ?? 90);
  const trim = () => {
    const n = store.trimRequests(retentionDays);
    if (n) console.log(`retention: trimmed ${n} request row(s) older than ${retentionDays}d`);
  };
  trim();
  setInterval(trim, 24 * 60 * 60_000).unref();

  let timer: NodeJS.Timeout | undefined;
  watch(productsPath, () => {
    clearTimeout(timer);
    timer = setTimeout(reload, 300); // fs.watch fires in bursts; debounce
  });

  const srv = serve({ fetch: proxyAwareFetch(app), port: env.port, hostname: "127.0.0.1" });
  console.log(`x402-sandbox on http://127.0.0.1:${env.port} (network ${env.network})`);
  console.log(`catalog: /catalog  feed: /feed  admin: /admin (user "admin")`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
