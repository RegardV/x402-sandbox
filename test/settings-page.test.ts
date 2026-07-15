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

function fixture(onRestart?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "x402-spage-"));
  writeFileSync(join(dir, ".env"), ENV, { mode: 0o600 });
  const booted = loadEnv({
    PAY_TO: "0x1111111111111111111111111111111111111111",
    NETWORK: "eip155:84532",
    FACILITATOR_URL: "https://x402.org/facilitator",
    ADMIN_PASSWORD: "a-long-admin-password",
    IP_SALT: "abc123",
  });
  const app = new Hono().route("/admin", settingsRoutes(dir, booted, onRestart));
  return { dir, app };
}

const save = (app: Hono, fields: Record<string, string>) =>
  app.request("/admin/settings", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });

describe("settings page restart banner", () => {
  test("no banner when the running config matches .env", async () => {
    const html = await (await fixture().app.request("/admin/settings")).text();
    expect(html).not.toContain("Restart pending");
  });

  test("saving a change shows the restart notice AND the persistent pending banner", async () => {
    const f = fixture();
    const res = await save(f.app, { payToTestnet: "0x3333333333333333333333333333333333333333" });
    const html = await res.text();
    expect(html).toContain("Restart pending");
    // banner persists on a plain revisit, not just the post-save response
    const revisit = await (await f.app.request("/admin/settings")).text();
    expect(revisit).toContain("Restart pending");
  });

  test("restart button shows in the pending banner when a restart handler exists", async () => {
    const f = fixture(() => {});
    const html = await (await save(f.app, { payToTestnet: "0x3333333333333333333333333333333333333333" })).text();
    expect(html).toContain('action="/admin/restart"');
    // without a handler (test/embedded mode) no button is offered
    const bare = fixture();
    const html2 = await (await save(bare.app, { payToTestnet: "0x3333333333333333333333333333333333333333" })).text();
    expect(html2).not.toContain('action="/admin/restart"');
  });

  test("POST /admin/restart triggers the handler and renders the restarting page", async () => {
    let called = 0;
    const f = fixture(() => called++);
    const res = await f.app.request("/admin/restart", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Restarting");
    expect(called).toBe(0); // deferred so the response flushes first
    await new Promise((r) => setTimeout(r, 400));
    expect(called).toBe(1);
  });

  test("POST /admin/restart without a handler → 404", async () => {
    const f = fixture();
    expect((await f.app.request("/admin/restart", { method: "POST" })).status).toBe(404);
  });
});
