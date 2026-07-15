import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { runHeadless } from "../src/cli/headless.js";

describe("runHeadless", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "x402-headless-"))));

  const env = { X402_ADMIN_PASSWORD: "a-long-admin-password" };

  test("happy path: provisions from declarative config, machine-readable result, exit 0", () => {
    writeFileSync(join(dir, "a.md"), "x");
    const r = runHeadless(
      dir,
      {
        payTo: "0x1111111111111111111111111111111111111111",
        products: [{ sku: "a", title: "A", price: "$0.01", route: "GET /a.md", contentPath: "./a.md" }],
      },
      env,
    );
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    expect(r.result.wroteEnv).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(JSON.parse(JSON.stringify(r.result))).toBeTruthy(); // JSON-serializable
  });

  test("missing admin password env → exit 1, error names X402_ADMIN_PASSWORD, nothing written", () => {
    const r = runHeadless(dir, { payTo: "0x1111111111111111111111111111111111111111" }, {});
    expect(r.exitCode).toBe(1);
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toMatch(/X402_ADMIN_PASSWORD/);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  test("secrets are never accepted inside the config object", () => {
    const r = runHeadless(
      dir,
      { payTo: "0x1111111111111111111111111111111111111111", adminPassword: "in-config-oops" } as never,
      env,
    );
    expect(r.exitCode).toBe(1);
    expect(r.result.error).toMatch(/env/i);
  });

  test("devWallet:true generates payTo on testnet; refused on mainnet", () => {
    const ok = runHeadless(dir, { devWallet: true }, env);
    expect(ok.exitCode).toBe(0);
    expect(ok.result.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const dir2 = mkdtempSync(join(tmpdir(), "x402-headless-"));
    const bad = runHeadless(dir2, { devWallet: true, network: "eip155:8453" }, env);
    expect(bad.exitCode).toBe(1);
    expect(bad.result.error).toMatch(/mainnet/i);
  });

  test("idempotent: second run exits 0 with a warning, env preserved", () => {
    const first = runHeadless(dir, { payTo: "0x1111111111111111111111111111111111111111" }, env);
    expect(first.exitCode).toBe(0);
    const second = runHeadless(dir, { payTo: "0x2222222222222222222222222222222222222222" }, env);
    expect(second.exitCode).toBe(0);
    expect(second.result.wroteEnv).toBe(false);
    expect(second.result.warnings.join(" ")).toMatch(/\.env/);
  });

  test("invalid config → exit 1 with the validator's message", () => {
    const r = runHeadless(dir, { payTo: "bad" }, env);
    expect(r.exitCode).toBe(1);
    expect(r.result.error).toMatch(/PAY_TO/);
  });
});
