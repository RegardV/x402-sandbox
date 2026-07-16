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

describe("bazaar discovery declarations", () => {
  test("discoverable products auto-gain a real extensions.bazaar declaration", () => {
    const p: ProductConfig = { sku: "d2", title: "D2", price: "$0.01", route: "GET /d2/*", contentDir: "/x", discoverable: true };
    const routes = buildRoutes([p], env);
    const ext = (routes["GET /d2/*"] as any).extensions;
    expect(ext.discoverable).toBe(true);
    expect(ext.bazaar).toBeDefined();
    expect(JSON.stringify(ext.bazaar)).toContain("GET");
  });

  test("operator-supplied extensions.bazaar wins over the auto declaration", () => {
    const routes = buildRoutes([dir], env);
    expect((routes["GET /docs/*"] as any).extensions.bazaar).toEqual({ tags: ["docs"] });
  });

  test("publicOrigin sets the public resource URL on exact routes", () => {
    const withOrigin = { ...env, publicOrigin: "https://store.example.com" };
    const routes = buildRoutes([file], withOrigin);
    expect((routes["GET /files/a.md"] as any).resource).toBe("https://store.example.com/files/a.md");
    const dirRoutes = buildRoutes([dir], withOrigin);
    expect((dirRoutes["GET /docs/*"] as any).resource).toBeUndefined(); // wildcards derive per-request
  });
});

describe("facilitator schema limits", () => {
  test("route descriptions are capped at 250 chars (CDP rejects longer)", () => {
    const long = { ...file, description: "d".repeat(3000) };
    const routes = buildRoutes([long], env);
    const desc = (routes["GET /files/a.md"] as any).description as string;
    expect(desc.length).toBeLessThanOrEqual(250);
    expect(desc.endsWith("…")).toBe(true);
  });
});
