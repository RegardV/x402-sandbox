import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, loadProducts } from "../src/config.js";

const validEnv = {
  PAY_TO: "0x1234567890abcdef1234567890abcdef12345678",
  ADMIN_PASSWORD: "supersecret123",
  IP_SALT: "salty",
};

describe("loadEnv", () => {
  it("happy path with defaults", () => {
    const cfg = loadEnv(validEnv);
    expect(cfg).toEqual({
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
      network: "eip155:84532",
      facilitatorUrl: "https://x402.org/facilitator",
      adminPassword: "supersecret123",
      ipSalt: "salty",
      port: 8402,
      dbPath: "./sandbox.db",
      cdpApiKeyId: undefined,
      cdpApiKeySecret: undefined,
    });
  });

  it("reads explicit values", () => {
    const cfg = loadEnv({
      ...validEnv,
      NETWORK: "eip155:1",
      FACILITATOR_URL: "https://fac.example",
      PORT: "3000",
      DB_PATH: "/tmp/x.db",
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "sec",
    });
    expect(cfg.network).toBe("eip155:1");
    expect(cfg.facilitatorUrl).toBe("https://fac.example");
    expect(cfg.port).toBe(3000);
    expect(cfg.dbPath).toBe("/tmp/x.db");
    expect(cfg.cdpApiKeyId).toBe("id");
    expect(cfg.cdpApiKeySecret).toBe("sec");
  });

  it("throws when PAY_TO missing", () => {
    const { PAY_TO, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow(/PAY_TO/);
  });

  it("throws when PAY_TO malformed", () => {
    expect(() => loadEnv({ ...validEnv, PAY_TO: "0x123" })).toThrow(/PAY_TO/);
  });

  it("throws when ADMIN_PASSWORD missing", () => {
    const { ADMIN_PASSWORD, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow(/ADMIN_PASSWORD/);
  });

  it("throws when ADMIN_PASSWORD shorter than 12 chars", () => {
    expect(() => loadEnv({ ...validEnv, ADMIN_PASSWORD: "short" })).toThrow(
      /ADMIN_PASSWORD/,
    );
  });

  it("throws when IP_SALT missing", () => {
    const { IP_SALT, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow(/IP_SALT/);
  });

  it("throws when IP_SALT empty", () => {
    expect(() => loadEnv({ ...validEnv, IP_SALT: "" })).toThrow(/IP_SALT/);
  });

  it("throws when PORT is not a positive int", () => {
    expect(() => loadEnv({ ...validEnv, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadEnv({ ...validEnv, PORT: "0" })).toThrow(/PORT/);
    expect(() => loadEnv({ ...validEnv, PORT: "-1" })).toThrow(/PORT/);
  });

  it("throws on mainnet without CDP keys", () => {
    expect(() => loadEnv({ ...validEnv, NETWORK: "eip155:8453" })).toThrow(
      /CDP_API_KEY_ID/,
    );
  });

  it("allows mainnet with CDP keys", () => {
    const cfg = loadEnv({
      ...validEnv,
      NETWORK: "eip155:8453",
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "sec",
    });
    expect(cfg.network).toBe("eip155:8453");
  });
});

const baseDir = mkdtempSync(join(tmpdir(), "x402-config-test-"));

function product(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sku: "a",
    title: "Product A",
    price: "$0.05",
    route: "GET /bundles/a",
    contentPath: "./a.md",
    ...overrides,
  };
}

function json(...products: Record<string, unknown>[]): string {
  return JSON.stringify({ products });
}

describe("loadProducts", () => {
  it("happy path", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-docs-"));
    const result = loadProducts(
      json(
        product(),
        product({ sku: "b", price: 0.1, bundlePath: "./b.zip", contentPath: undefined, route: "POST /b" }),
        product({
          sku: "c",
          contentPath: undefined,
          contentDir: dir,
          route: "GET /docs/*",
          network: "eip155:84532",
          description: "d",
          mimeType: "text/plain",
          discoverable: true,
          extensions: { x: 1 },
        }),
      ),
      baseDir,
    );
    expect(result).toHaveLength(3);
    expect(result[0]!.sku).toBe("a");
    expect(result[2]!.contentDir).toBe(dir);
  });

  it("throws on invalid JSON", () => {
    expect(() => loadProducts("not json", baseDir)).toThrow();
  });

  it("throws on missing products array", () => {
    expect(() => loadProducts("{}", baseDir)).toThrow(/products/);
  });

  it("throws on empty sku", () => {
    expect(() => loadProducts(json(product({ sku: "" })), baseDir)).toThrow(/sku/);
  });

  it("throws on duplicate sku", () => {
    expect(() => loadProducts(json(product(), product()), baseDir)).toThrow(/a/);
  });

  it("throws on empty title", () => {
    expect(() => loadProducts(json(product({ title: "" })), baseDir)).toThrow(
      /title/,
    );
  });

  it("throws on non-positive numeric price", () => {
    expect(() => loadProducts(json(product({ price: 0 })), baseDir)).toThrow(
      /price/,
    );
    expect(() => loadProducts(json(product({ price: -1 })), baseDir)).toThrow(
      /price/,
    );
  });

  it("throws on malformed string price", () => {
    expect(() => loadProducts(json(product({ price: "0.05" })), baseDir)).toThrow(
      /price/,
    );
    expect(() => loadProducts(json(product({ price: "$abc" })), baseDir)).toThrow(
      /price/,
    );
  });

  it("throws on zero string price", () => {
    expect(() => loadProducts(json(product({ price: "$0" })), baseDir)).toThrow(
      /price/,
    );
  });

  it("accepts valid string price", () => {
    const result = loadProducts(json(product({ price: "$1.50" })), baseDir);
    expect(result[0]!.price).toBe("$1.50");
  });

  it("throws on invalid network", () => {
    expect(() =>
      loadProducts(json(product({ network: "base-sepolia" })), baseDir),
    ).toThrow(/network/);
  });

  it("throws on invalid route", () => {
    expect(() => loadProducts(json(product({ route: "FETCH /a" })), baseDir)).toThrow(
      /route/,
    );
    expect(() => loadProducts(json(product({ route: "GET noSlash" })), baseDir)).toThrow(
      /route/,
    );
  });

  it("throws when no content source set", () => {
    expect(() =>
      loadProducts(json(product({ contentPath: undefined })), baseDir),
    ).toThrow(/a/);
  });

  it("throws when multiple content sources set", () => {
    expect(() =>
      loadProducts(json(product({ bundlePath: "./b.zip" })), baseDir),
    ).toThrow(/a/);
  });

  it("throws when contentDir does not exist", () => {
    expect(() =>
      loadProducts(
        json(product({ contentPath: undefined, contentDir: "./nope", route: "GET /docs/*" })),
        baseDir,
      ),
    ).toThrow(/contentDir/);
  });

  it("resolves relative contentDir against baseDir", () => {
    const dir = mkdtempSync(join(baseDir, "docs-"));
    const rel = dir.slice(baseDir.length + 1);
    const result = loadProducts(
      json(product({ contentPath: undefined, contentDir: rel, route: "GET /docs/*" })),
      baseDir,
    );
    expect(result[0]!.contentDir).toBe(dir);
  });

  it("throws when contentDir route lacks /* wildcard", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-docs-"));
    expect(() =>
      loadProducts(
        json(product({ contentPath: undefined, contentDir: dir, route: "GET /docs" })),
        baseDir,
      ),
    ).toThrow(/route/);
  });

  it("throws when contentPath route ends with /*", () => {
    expect(() =>
      loadProducts(json(product({ route: "GET /bundles/*" })), baseDir),
    ).toThrow(/route/);
  });
});
