import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadProducts, type EnvConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { buildRoutes } from "../src/routes.js";
import { nextPrice, repriceOnce } from "../src/pricing.js";

const env: EnvConfig = {
  payTo: "0x1111111111111111111111111111111111111111",
  network: "eip155:84532",
  facilitatorUrl: "https://x402.org/facilitator",
  adminPassword: "test-password-123",
  ipSalt: "s",
  port: 8402,
  dbPath: ":memory:",
};

const demand = { mode: "demand" as const, floor: "$0.001", ceiling: "$0.10", step: 0.1, windowMinutes: 15 };

function demandProductJson(extra: object = {}) {
  return JSON.stringify({
    products: [{ sku: "d", title: "D", route: "GET /d/*", contentDir: ".", pricing: demand, ...extra }],
  });
}

describe("config: pricing field", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-price-"));

  test("pricing accepted without price; exposed on the product", () => {
    const [p] = loadProducts(demandProductJson(), dir);
    expect(p!.pricing).toEqual(demand);
  });

  test("price and pricing together rejected; neither rejected", () => {
    expect(() => loadProducts(demandProductJson({ price: "$0.05" }), dir)).toThrow(/price/);
    const none = JSON.stringify({ products: [{ sku: "d", title: "D", route: "GET /d/*", contentDir: "." }] });
    expect(() => loadProducts(none, dir)).toThrow(/price/);
  });

  test("floor must be below ceiling; step in (0,1); window >= 1", () => {
    expect(() => loadProducts(demandProductJson({ pricing: { ...demand, floor: "$0.20" } }), dir)).toThrow(/floor/);
    expect(() => loadProducts(demandProductJson({ pricing: { ...demand, step: 1.5 } }), dir)).toThrow(/step/);
    expect(() => loadProducts(demandProductJson({ pricing: { ...demand, windowMinutes: 0 } }), dir)).toThrow(/window/);
  });
});

describe("nextPrice (pure policy)", () => {
  test("no purchases → decays by step toward floor, never below", () => {
    expect(nextPrice(0.01, 0, demand)).toBeCloseTo(0.009, 6);
    expect(nextPrice(0.001, 0, demand)).toBe(0.001);
  });
  test("purchases → steps up toward ceiling, never above", () => {
    expect(nextPrice(0.01, 3, demand)).toBeCloseTo(0.011, 6);
    expect(nextPrice(0.1, 5, demand)).toBe(0.1);
  });
});

describe("repriceOnce", () => {
  function setup() {
    const store = new Store(":memory:");
    store.syncProducts([{ sku: "d", title: "D", price: "$0.01", network: env.network, contentDir: "." }]);
    const dir = mkdtempSync(join(tmpdir(), "x402-rp-"));
    const products = loadProducts(demandProductJson(), dir);
    return { store, products };
  }

  test("quiet window decays the persisted price and reports the change", () => {
    const { store, products } = setup();
    const changes = repriceOnce(store, products);
    expect(changes).toEqual([{ sku: "d", previous: "0.01", current: "0.009" }]);
    expect(store.productBySku("d")!.priceUsdc).toBe("0.009");
  });

  test("sales in window raise the price", () => {
    const { store, products } = setup();
    store.insertSettlement({
      ts: new Date().toISOString(),
      productId: store.productBySku("d")!.id,
      amountUsdc: "0.01",
      payer: "0xabc",
      txHash: "0x1",
      network: env.network,
    });
    const changes = repriceOnce(store, products);
    expect(changes[0]!.current).toBe("0.011");
  });

  test("fixed-price products are untouched", () => {
    const store = new Store(":memory:");
    store.syncProducts([{ sku: "f", title: "F", price: "$0.05", network: env.network, contentPath: "./x" }]);
    const dir = mkdtempSync(join(tmpdir(), "x402-rp2-"));
    writeFileSync(join(dir, "x"), "x");
    const products = loadProducts(
      JSON.stringify({ products: [{ sku: "f", title: "F", price: "$0.05", route: "GET /x", contentPath: "./x" }] }),
      dir,
    );
    expect(repriceOnce(store, products)).toEqual([]);
    expect(store.productBySku("f")!.priceUsdc).toBe("0.05");
  });
});

describe("buildRoutes with live prices + grace", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-br-"));
  const products = loadProducts(demandProductJson(), dir);

  test("price override replaces the static price", () => {
    const routes = buildRoutes(products, env, new Map([["d", { current: "0.009" }]]));
    expect((routes["GET /d/*"] as any).accepts).toEqual([
      { scheme: "exact", payTo: env.payTo, price: "$0.009", network: env.network },
    ]);
  });

  test("grace: previous price stays accepted as a second option", () => {
    const routes = buildRoutes(products, env, new Map([["d", { current: "0.009", previous: "0.01" }]]));
    const accepts = (routes["GET /d/*"] as any).accepts;
    expect(accepts.map((a: any) => a.price)).toEqual(["$0.009", "$0.01"]);
  });

  test("demand product without override falls back to floor", () => {
    const routes = buildRoutes(products, env);
    expect((routes["GET /d/*"] as any).accepts[0].price).toBe("$0.001");
  });
});
