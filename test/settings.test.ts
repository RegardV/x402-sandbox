import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { applySettings, readEnvFile } from "../src/settings.js";
import { generateDevWallet } from "../src/provision.js";

const BASE_ENV = `PAY_TO=0x1111111111111111111111111111111111111111
NETWORK=eip155:84532
FACILITATOR_URL=https://x402.org/facilitator
ADMIN_PASSWORD=a-long-admin-password
IP_SALT=abc123
`;

describe("settings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-settings-"));
    writeFileSync(join(dir, ".env"), BASE_ENV, { mode: 0o600 });
  });

  test("readEnvFile parses KEY=VALUE lines", () => {
    expect(readEnvFile(join(dir, ".env")).PAY_TO).toBe("0x1111111111111111111111111111111111111111");
  });

  test("flip to mainnet without CDP keys is refused", () => {
    expect(() => applySettings(dir, { mode: "mainnet" })).toThrow(/CDP/);
    expect(readEnvFile(join(dir, ".env")).NETWORK).toBe("eip155:84532"); // untouched
  });

  test("flip to mainnet with CDP keys writes network and keeps unknown keys, 0600, no tmp", () => {
    applySettings(dir, { mode: "mainnet", cdpApiKeyId: "id", cdpApiKeySecret: "sec" });
    const env = readEnvFile(join(dir, ".env"));
    expect(env.NETWORK).toBe("eip155:8453");
    expect(env.CDP_API_KEY_ID).toBe("id");
    expect(env.IP_SALT).toBe("abc123");
    expect(env.ADMIN_PASSWORD).toBe("a-long-admin-password");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  test("mainnet with a generated dev wallet as payTo is refused", () => {
    const w = generateDevWallet(dir);
    expect(() =>
      applySettings(dir, { mode: "mainnet", payTo: w.address, cdpApiKeyId: "id", cdpApiKeySecret: "sec" }),
    ).toThrow(/dev wallet/i);
  });

  test("flip back to testnet resets network and facilitator", () => {
    applySettings(dir, { mode: "mainnet", cdpApiKeyId: "id", cdpApiKeySecret: "sec" });
    applySettings(dir, { mode: "testnet" });
    const env = readEnvFile(join(dir, ".env"));
    expect(env.NETWORK).toBe("eip155:84532");
    expect(env.FACILITATOR_URL).toBe("https://x402.org/facilitator");
  });

  test("invalid payTo refused with the loadEnv message", () => {
    expect(() => applySettings(dir, { payTo: "nope" })).toThrow(/PAY_TO/);
  });

  test("empty-string updates are ignored (form fields left blank)", () => {
    applySettings(dir, { payTo: "", cdpApiKeyId: "" });
    expect(readEnvFile(join(dir, ".env")).PAY_TO).toBe("0x1111111111111111111111111111111111111111");
  });
});
