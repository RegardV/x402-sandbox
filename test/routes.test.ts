import { describe, expect, test } from "vitest";
import { buildRoutes } from "../src/routes.js";
import type { EnvConfig, ProductConfig } from "../src/config.js";

const env: EnvConfig = {
  payTo: "0x1111111111111111111111111111111111111111",
  network: "eip155:84532",
  facilitatorUrl: "https://x402.org/facilitator",
  adminPassword: "test-password-123",
  ipSalt: "salt",
  port: 8402,
  dbPath: ":memory:",
};

const file: ProductConfig = {
  sku: "a",
  title: "A",
  description: "desc",
  price: "$0.05",
  route: "GET /files/a.md",
  contentPath: "./content/a.md",
  mimeType: "text/markdown",
};

const dir: ProductConfig = {
  sku: "d",
  title: "D",
  price: 0.02,
  network: "eip155:8453",
  route: "GET /docs/*",
  contentDir: "/abs/docs",
  discoverable: true,
  extensions: { bazaar: { tags: ["docs"] } },
};

describe("buildRoutes", () => {
  test("one route key per product, keyed by the product route", () => {
    const routes = buildRoutes([file, dir], env);
    expect(Object.keys(routes).sort()).toEqual(["GET /docs/*", "GET /files/a.md"]);
  });

  test("injects payTo and scheme exact from env, price and description pass through", () => {
    const routes = buildRoutes([file], env);
    const cfg = routes["GET /files/a.md"] as any;
    expect(cfg.accepts).toEqual([
      { scheme: "exact", payTo: env.payTo, price: "$0.05", network: "eip155:84532" },
    ]);
    expect(cfg.description).toBe("desc");
    expect(cfg.mimeType).toBe("text/markdown");
  });

  test("product network overrides env network", () => {
    const routes = buildRoutes([dir], env);
    expect((routes["GET /docs/*"] as any).accepts[0].network).toBe("eip155:8453");
  });

  test("numeric price passes through unchanged", () => {
    const routes = buildRoutes([dir], env);
    expect((routes["GET /docs/*"] as any).accepts[0].price).toBe(0.02);
  });

  test("discoverable and extensions merge under extensions (not first-class)", () => {
    const routes = buildRoutes([dir], env);
    const cfg = routes["GET /docs/*"] as any;
    expect(cfg.extensions.bazaar).toEqual({ tags: ["docs"] });
    expect(cfg.extensions.discoverable).toBe(true);
    expect(cfg.discoverable).toBeUndefined();
  });

  test("no extensions key when neither discoverable nor extensions set", () => {
    const routes = buildRoutes([file], env);
    expect((routes["GET /files/a.md"] as any).extensions).toBeUndefined();
  });

  test("duplicate route keys throw", () => {
    expect(() => buildRoutes([file, { ...dir, route: file.route }], env)).toThrow(/route/i);
  });

  test("empty product list yields empty routes", () => {
    expect(buildRoutes([], env)).toEqual({});
  });
});
