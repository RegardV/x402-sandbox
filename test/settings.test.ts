import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { applySettings, readEnvFile } from "../src/settings.js";
import { generateDevWallet } from "../src/provision.js";

const TEST_ADDR = "0x1111111111111111111111111111111111111111";
const LIVE_ADDR = "0x2222222222222222222222222222222222222222";

const BASE_ENV = `PAY_TO=${TEST_ADDR}
NETWORK=eip155:84532
FACILITATOR_URL=https://x402.org/facilitator
ADMIN_PASSWORD=a-long-admin-password
IP_SALT=abc123
`;

describe("settings — two receive channels", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-settings-"));
    writeFileSync(join(dir, ".env"), BASE_ENV, { mode: 0o600 });
  });

  test("legacy PAY_TO migrates into the testnet slot on first save", () => {
    applySettings(dir, {});
    const env = readEnvFile(join(dir, ".env"));
    expect(env.PAY_TO_TESTNET).toBe(TEST_ADDR);
    expect(env.PAY_TO).toBe(TEST_ADDR);
  });

  test("setting the mainnet address while on testnet stores it without touching the active PAY_TO", () => {
    applySettings(dir, { payToMainnet: LIVE_ADDR });
    const env = readEnvFile(join(dir, ".env"));
    expect(env.PAY_TO_MAINNET).toBe(LIVE_ADDR);
    expect(env.PAY_TO).toBe(TEST_ADDR);
    expect(env.NETWORK).toBe("eip155:84532");
  });

  test("flip to mainnet without a mainnet address is refused with a clear message", () => {
    expect(() => applySettings(dir, { mode: "mainnet", cdpApiKeyId: "id", cdpApiKeySecret: "sec" })).toThrow(
      /mainnet receive address/i,
    );
  });

  test("flip to mainnet activates the mainnet channel; flip back restores the testnet one", () => {
    applySettings(dir, { payToMainnet: LIVE_ADDR, cdpApiKeyId: "id", cdpApiKeySecret: "sec" });
    applySettings(dir, { mode: "mainnet" });
    let env = readEnvFile(join(dir, ".env"));
    expect(env.NETWORK).toBe("eip155:8453");
    expect(env.PAY_TO).toBe(LIVE_ADDR);

    applySettings(dir, { mode: "testnet" });
    env = readEnvFile(join(dir, ".env"));
    expect(env.PAY_TO).toBe(TEST_ADDR);
    expect(env.PAY_TO_MAINNET).toBe(LIVE_ADDR); // channel survives the flip
    expect(env.FACILITATOR_URL).toBe("https://x402.org/facilitator");
  });

  test("mainnet without CDP keys still refused; env untouched", () => {
    applySettings(dir, { payToMainnet: LIVE_ADDR });
    expect(() => applySettings(dir, { mode: "mainnet" })).toThrow(/CDP/);
    expect(readEnvFile(join(dir, ".env")).NETWORK).toBe("eip155:84532");
  });

  test("a generated dev wallet is refused as the mainnet address", () => {
    const w = generateDevWallet(dir);
    expect(() =>
      applySettings(dir, { mode: "mainnet", payToMainnet: w.address, cdpApiKeyId: "id", cdpApiKeySecret: "sec" }),
    ).toThrow(/dev wallet/i);
  });

  test("malformed addresses are refused per slot", () => {
    expect(() => applySettings(dir, { payToTestnet: "nope" })).toThrow(/PAY_TO_TESTNET/);
    expect(() => applySettings(dir, { payToMainnet: "nope" })).toThrow(/PAY_TO_MAINNET/);
  });

  test("blank form fields keep current values; file stays 0600 with unknown keys preserved", () => {
    applySettings(dir, { payToTestnet: "", payToMainnet: "", cdpApiKeyId: "" });
    const env = readEnvFile(join(dir, ".env"));
    expect(env.PAY_TO).toBe(TEST_ADDR);
    expect(env.IP_SALT).toBe("abc123");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });
});
