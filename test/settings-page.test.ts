import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { settingsRoutes } from "../src/settings.js";
import { loadEnv } from "../src/config.js";

const ENV = `PAY_TO=0x1111111111111111111111111111111111111111
PAY_TO_TESTNET=0x1111111111111111111111111111111111111111
NETWORK=eip155:84532
FACILITATOR_URL=https://x402.org/facilitator
ADMIN_PASSWORD=a-long-admin-password
IP_SALT=abc123
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "x402-spage-"));
  writeFileSync(join(dir, ".env"), ENV, { mode: 0o600 });
  const booted = loadEnv({
    PAY_TO: "0x1111111111111111111111111111111111111111",
    NETWORK: "eip155:84532",
    FACILITATOR_URL: "https://x402.org/facilitator",
    ADMIN_PASSWORD: "a-long-admin-password",
    IP_SALT: "abc123",
  });
  const app = new Hono().route("/admin", settingsRoutes(dir, booted));
  return { dir, app };
}

describe("settings page restart banner", () => {
  test("no banner when the running config matches .env", async () => {
    const html = await (await fixture().app.request("/admin/settings")).text();
    expect(html).not.toContain("Restart pending");
  });

  test("saving a change shows the restart notice AND the persistent pending banner", async () => {
    const f = fixture();
    const res = await f.app.request("/admin/settings", {
      method: "POST",
      body: new URLSearchParams({ payToTestnet: "0x3333333333333333333333333333333333333333" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const html = await res.text();
    expect(html).toContain("Restart pending");
    // banner persists on a plain revisit, not just the post-save response
    const revisit = await (await f.app.request("/admin/settings")).text();
    expect(revisit).toContain("Restart pending");
  });
});
