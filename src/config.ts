import { statSync } from "node:fs";
import { resolve } from "node:path";

export interface DemandPricing {
  mode: "demand";
  floor: string; // "$0.001"
  ceiling: string; // "$0.10"
  step: number; // multiplicative, (0,1)
  windowMinutes: number;
}

export interface ProductConfig {
  sku: string;
  title: string;
  description?: string;
  price?: string | number; // exactly one of price | pricing
  pricing?: DemandPricing;
  network?: string;
  route: string;
  contentPath?: string;
  bundlePath?: string;
  contentDir?: string;
  mimeType?: string;
  discoverable?: boolean;
  /** Show a short text excerpt of md/txt files on the catalog (deliberate teaser). */
  preview?: boolean;
  extensions?: Record<string, unknown>;
}

export interface EnvConfig {
  payTo: `0x${string}`;
  network: string;
  facilitatorUrl: string;
  adminPassword: string;
  ipSalt: string;
  port: number;
  dbPath: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
}

export function loadEnv(
  env: Record<string, string | undefined> = process.env,
): EnvConfig {
  const payTo = env.PAY_TO;
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error("PAY_TO is required and must be a 0x-prefixed 40-hex-char address");
  }
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD is required and must be at least 12 characters");
  }
  const ipSalt = env.IP_SALT;
  if (!ipSalt) {
    throw new Error("IP_SALT is required and must be non-empty");
  }
  const portRaw = env.PORT ?? "8402";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got "${portRaw}"`);
  }
  const network = env.NETWORK ?? "eip155:84532";
  const cdpApiKeyId = env.CDP_API_KEY_ID;
  const cdpApiKeySecret = env.CDP_API_KEY_SECRET;
  if (network === "eip155:8453" && (!cdpApiKeyId || !cdpApiKeySecret)) {
    throw new Error("mainnet requires CDP_API_KEY_ID/CDP_API_KEY_SECRET");
  }
  return {
    payTo: payTo as `0x${string}`,
    network,
    facilitatorUrl: env.FACILITATOR_URL ?? "https://x402.org/facilitator",
    adminPassword,
    ipSalt,
    port,
    dbPath: env.DB_PATH ?? "./sandbox.db",
    cdpApiKeyId,
    cdpApiKeySecret,
  };
}

function fail(sku: string, field: string, reason: string): never {
  throw new Error(`Product "${sku}": ${field} ${reason}`);
}

export function loadProducts(jsonText: string, baseDir: string): ProductConfig[] {
  const parsed: unknown = JSON.parse(jsonText);
  const products = (parsed as { products?: unknown })?.products;
  if (!Array.isArray(products)) {
    throw new Error('Config must have a "products" array');
  }
  const seen = new Set<string>();
  return products.map((raw): ProductConfig => {
    const p = raw as ProductConfig;
    const sku = p.sku;
    if (typeof sku !== "string" || sku === "") {
      fail(String(sku), "sku", "must be a non-empty string");
    }
    if (seen.has(sku)) fail(sku, "sku", "is duplicated");
    seen.add(sku);

    if (typeof p.title !== "string" || p.title === "") {
      fail(sku, "title", "must be a non-empty string");
    }
    if ((p.price === undefined) === (p.pricing === undefined)) {
      fail(sku, "price", "exactly one of price or pricing must be set");
    }
    if (typeof p.price === "number") {
      if (!(p.price > 0)) fail(sku, "price", "must be > 0");
    } else if (typeof p.price === "string") {
      if (!/^\$\d+(\.\d+)?$/.test(p.price) || !(Number(p.price.slice(1)) > 0)) {
        fail(sku, "price", 'must match "$<amount>" with value > 0');
      }
    } else if (p.price !== undefined) {
      fail(sku, "price", "must be a number or a $-prefixed string");
    }
    if (p.pricing !== undefined) {
      const pr = p.pricing;
      const money = (v: unknown) => typeof v === "string" && /^\$\d+(\.\d+)?$/.test(v) && Number(v.slice(1)) > 0;
      if (pr.mode !== "demand") fail(sku, "pricing.mode", 'must be "demand"');
      if (!money(pr.floor) || !money(pr.ceiling)) fail(sku, "pricing", "floor/ceiling must be $-strings > 0");
      if (Number(pr.floor.slice(1)) >= Number(pr.ceiling.slice(1))) {
        fail(sku, "pricing", "floor must be below ceiling");
      }
      if (typeof pr.step !== "number" || !(pr.step > 0 && pr.step < 1)) {
        fail(sku, "pricing", "step must be a number in (0,1)");
      }
      if (typeof pr.windowMinutes !== "number" || !(pr.windowMinutes >= 1)) {
        fail(sku, "pricing", "windowMinutes must be >= 1");
      }
    }
    if (p.network !== undefined && !/^eip155:\d+$/.test(p.network)) {
      fail(sku, "network", 'must match "eip155:<chainId>"');
    }
    if (typeof p.route !== "string" || !/^(GET|POST|PUT|DELETE|PATCH) \/\S+$/.test(p.route)) {
      fail(sku, "route", 'must match "<METHOD> /path"');
    }
    if (p.preview !== undefined && typeof p.preview !== "boolean") {
      fail(sku, "preview", "must be a boolean");
    }
    const sources = [p.contentPath, p.bundlePath, p.contentDir].filter(
      (v) => v !== undefined,
    );
    if (sources.length !== 1) {
      fail(sku, "contentPath/bundlePath/contentDir", "exactly one must be set");
    }
    const isWildcard = p.route.endsWith("/*");
    if (p.contentDir !== undefined) {
      if (!isWildcard) fail(sku, "route", 'must end with "/*" for contentDir products');
      const abs = resolve(baseDir, p.contentDir);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        fail(sku, "contentDir", `does not exist: ${abs}`);
      }
      if (!stat.isDirectory()) fail(sku, "contentDir", `is not a directory: ${abs}`);
      return { ...p, contentDir: abs };
    }
    if (isWildcard) {
      fail(sku, "route", 'must not end with "/*" for contentPath/bundlePath products');
    }
    return { ...p };
  });
}
