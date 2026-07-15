import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { assertNotDevWalletOnMainnet, generateDevWallet, provision } from "../src/provision.js";

const answers = () => ({
  payTo: "0x1111111111111111111111111111111111111111",
  adminPassword: "a-long-admin-password",
});

describe("provision", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "x402-prov-"))));

  test("writes .env (0600) with defaults and products.json when given", () => {
    writeFileSync(join(dir, "a.md"), "x");
    const r = provision(dir, {
      ...answers(),
      products: [{ sku: "a", title: "A", price: "$0.01", route: "GET /a.md", contentPath: "./a.md" }],
    });
    expect(r.wroteEnv).toBe(true);
    expect(r.wroteProducts).toBe(true);
    const env = readFileSync(r.envPath, "utf8");
    expect(env).toContain("PAY_TO=0x1111111111111111111111111111111111111111");
    expect(env).toContain("NETWORK=eip155:84532");
    expect(env).toMatch(/IP_SALT=[0-9a-f]{32}/);
    expect(statSync(r.envPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(r.productsPath, "utf8")).products[0].sku).toBe("a");
    expect(existsSync(r.envPath + ".tmp")).toBe(false);
  });

  test("invalid payTo throws naming PAY_TO; nothing written", () => {
    expect(() => provision(dir, { ...answers(), payTo: "nope" })).toThrow(/PAY_TO/);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  test("short adminPassword throws", () => {
    expect(() => provision(dir, { ...answers(), adminPassword: "short" })).toThrow(/ADMIN_PASSWORD/i);
  });

  test("invalid product rejected before write", () => {
    expect(() => provision(dir, { ...answers(), products: [{ sku: "x", title: "X", price: "$0.01", route: "GET /x" }] })).toThrow(/x/);
    expect(existsSync(join(dir, "products.json"))).toBe(false);
  });

  test("idempotent: existing .env preserved, secrets not clobbered", () => {
    writeFileSync(join(dir, ".env"), "PAY_TO=0x2222222222222222222222222222222222222222\n");
    const r = provision(dir, answers());
    expect(r.wroteEnv).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/\.env/);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("0x2222");
  });

  test("products.json untouched when answers has no products", () => {
    writeFileSync(join(dir, "products.json"), '{"products":[]}');
    const r = provision(dir, answers());
    expect(r.wroteProducts).toBe(false);
  });
});

describe("dev wallet", () => {
  test("generateDevWallet writes 0600 key file; mainnet hard-block fires only for that wallet on mainnet", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-wallet-"));
    const w = generateDevWallet(dir);
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const keyFile = join(dir, ".dev-wallet.env");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, "utf8")).toContain(w.privateKey);

    expect(() => assertNotDevWalletOnMainnet(dir, "eip155:8453", w.address)).toThrow(/dev wallet/i);
    expect(() => assertNotDevWalletOnMainnet(dir, "eip155:84532", w.address)).not.toThrow();
    expect(() =>
      assertNotDevWalletOnMainnet(dir, "eip155:8453", "0x3333333333333333333333333333333333333333"),
    ).not.toThrow();
    const empty = mkdtempSync(join(tmpdir(), "x402-nowallet-"));
    expect(() => assertNotDevWalletOnMainnet(empty, "eip155:8453", w.address)).not.toThrow();
  });
});
