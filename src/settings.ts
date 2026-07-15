import { readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { loadEnv, type EnvConfig } from "./config.js";
import { assertNotDevWalletOnMainnet } from "./provision.js";
import { escapeHtml, page } from "./ui.js";

export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const TESTNET = { NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" };
const MAINNET = { NETWORK: "eip155:8453" };

export interface SettingsUpdate {
  mode?: "testnet" | "mainnet";
  payToTestnet?: string;
  payToMainnet?: string;
  facilitatorUrl?: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
}

const MAINNET_ID = "eip155:8453";
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Merge updates into .env with the SAME validation as startup (loadEnv), plus the
 *  dev-wallet-on-mainnet hard-block. Receive addresses are TWO separate channels
 *  (PAY_TO_TESTNET / PAY_TO_MAINNET); the effective PAY_TO is derived from the
 *  active network on every save, so flipping never reuses the other channel's wallet.
 *  Atomic 0600 write; unknown keys preserved; empty-string fields ignored. Throws on violation. */
export function applySettings(baseDir: string, update: SettingsUpdate): Record<string, string> {
  const envPath = join(baseDir, ".env");
  const env = readEnvFile(envPath);

  const set = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== "") env[key] = value;
  };
  set("CDP_API_KEY_ID", update.cdpApiKeyId);
  set("CDP_API_KEY_SECRET", update.cdpApiKeySecret);
  set("FACILITATOR_URL", update.facilitatorUrl);

  // Migrate a legacy single PAY_TO into the slot matching the CURRENT network.
  const wasMainnet = env["NETWORK"] === MAINNET_ID;
  if (env["PAY_TO"] && !env["PAY_TO_TESTNET"] && !wasMainnet) env["PAY_TO_TESTNET"] = env["PAY_TO"];
  if (env["PAY_TO"] && !env["PAY_TO_MAINNET"] && wasMainnet) env["PAY_TO_MAINNET"] = env["PAY_TO"];

  for (const [field, key] of [
    ["payToTestnet", "PAY_TO_TESTNET"],
    ["payToMainnet", "PAY_TO_MAINNET"],
  ] as const) {
    const v = update[field];
    if (v !== undefined && v !== "") {
      if (!ADDR.test(v)) throw new Error(`${key} must be a 0x-prefixed 40-hex-char address`);
      env[key] = v;
    }
  }

  if (update.mode === "mainnet") Object.assign(env, MAINNET);
  if (update.mode === "testnet") Object.assign(env, TESTNET);

  // The active channel becomes the effective PAY_TO.
  const isMainnet = env["NETWORK"] === MAINNET_ID;
  const active = isMainnet ? env["PAY_TO_MAINNET"] : env["PAY_TO_TESTNET"];
  if (isMainnet && !active) {
    throw new Error("mainnet receive address required — set the live-net wallet slot before flipping");
  }
  if (active) env["PAY_TO"] = active;

  loadEnv(env); // full startup rule set — incl. mainnet-requires-CDP-keys
  assertNotDevWalletOnMainnet(baseDir, env["NETWORK"]!, env["PAY_TO"]!);

  const tmp = `${envPath}.tmp`;
  writeFileSync(tmp, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, envPath);
  chmodSync(envPath, 0o600);
  console.log(
    `[admin-audit] ${new Date().toISOString()} settings ${Object.keys(update).filter((k) => update[k as keyof SettingsUpdate]).join(",")}`,
  );
  return env;
}

/** Settings page — mounted under the admin auth gate. Secrets are never echoed.
 *  `booted` is the config the RUNNING server loaded at startup: whenever .env
 *  differs from it, a persistent restart-pending banner shows. */
export function settingsRoutes(baseDir: string, booted: EnvConfig): Hono {
  const app = new Hono();

  const restartPending = (env: Record<string, string>): boolean =>
    env["NETWORK"] !== booted.network ||
    env["PAY_TO"] !== booted.payTo ||
    env["FACILITATOR_URL"] !== booted.facilitatorUrl ||
    (env["CDP_API_KEY_ID"] ?? "") !== (booted.cdpApiKeyId ?? "") ||
    (env["CDP_API_KEY_SECRET"] ?? "") !== (booted.cdpApiKeySecret ?? "") ||
    Number(env["PORT"] ?? 8402) !== booted.port;

  const render = (notice?: string, error?: string) => {
    const env = readEnvFile(join(baseDir, ".env"));
    const pending = restartPending(env)
      ? `<div class="card" style="border-color:var(--warn);background:var(--warn-soft)"><strong>⚠ Restart pending</strong> — the running server is still using the previous settings. Saved changes take effect after a restart: stop the process and run <code>npm start</code> (automatic under systemd).</div>`
      : "";
    const mainnet = env["NETWORK"] === "eip155:8453";
    const modeBadge = mainnet
      ? '<span class="badge bad">MAINNET — real funds</span>'
      : '<span class="badge good">TESTNET — no real money</span>';
    const keyState = (v?: string) => (v ? '<span class="badge good">set</span>' : '<span class="badge warn">not set</span>');
    const body = `
<h1>Settings</h1>
<p class="lede"><a href="/admin">← Admin</a> · gateway configuration. Changes are validated and written to <code>.env</code> — <strong>restart the server to apply</strong> (automatic under systemd).</p>
${error ? `<div class="card" style="border-color:var(--bad)"><span class="badge bad">error</span> ${escapeHtml(error)}</div>` : ""}
${notice ? `<div class="card" style="border-color:var(--good)"><span class="badge good">saved</span> ${escapeHtml(notice)}</div>` : ""}
${pending}

<div class="card">
<h2>Network ${modeBadge}</h2>
<form class="stack" method="post" action="/admin/settings">
  <label style="font-weight:400"><input type="radio" name="mode" value="testnet" ${mainnet ? "" : "checked"}> Testnet — Base Sepolia, free x402.org facilitator, test USDC</label>
  <label style="font-weight:400"><input type="radio" name="mode" value="mainnet" ${mainnet ? "checked" : ""}> Mainnet — Base, Coinbase CDP facilitator, <strong>real USDC</strong></label>
  <label>Testnet receive address <span class="badge good">test channel</span>${mainnet ? "" : ' <span class="badge plain">active</span>'}
    <input name="payToTestnet" value="${escapeHtml(env["PAY_TO_TESTNET"] ?? (mainnet ? "" : env["PAY_TO"] ?? ""))}" placeholder="0x… (any wallet — test USDC only)"></label>
  <label>Mainnet receive address <span class="badge bad">live channel</span>${mainnet ? ' <span class="badge plain">active</span>' : ""}
    <input name="payToMainnet" value="${escapeHtml(env["PAY_TO_MAINNET"] ?? (mainnet ? env["PAY_TO"] ?? "" : ""))}" placeholder="0x… (self-custody — real money settles here)"></label>
  <p class="muted">⚠ Two separate channels: the active network decides which one receives revenue. The live address must be self-custody (generated dev wallets are refused) — verify every character. Mainnet also needs CDP keys below.</p>
  <label>CDP API key id ${keyState(env["CDP_API_KEY_ID"])} <input name="cdpApiKeyId" placeholder="leave blank to keep current"></label>
  <label>CDP API key secret ${keyState(env["CDP_API_KEY_SECRET"])} <input type="password" name="cdpApiKeySecret" placeholder="leave blank to keep current"></label>
  <label>Facilitator URL (testnet) <input name="facilitatorUrl" value="${escapeHtml(env["FACILITATOR_URL"] ?? "")}"></label>
  <div><button type="submit" ${mainnet ? "" : 'onclick="return this.form.mode.value===\'mainnet\' ? confirm(\'Switch to MAINNET? Real money settles to the payTo wallet.\') : true"'}>Save settings</button></div>
</form>
</div>

<div class="card">
<h2>Read-only</h2>
<table>
<tr><td>Port</td><td>${escapeHtml(env["PORT"] ?? "8402")}</td></tr>
<tr><td>Database</td><td>${escapeHtml(env["DB_PATH"] ?? "./sandbox.db")}</td></tr>
<tr><td>Admin password</td><td class="muted">set — change it in .env, never shown here</td></tr>
</table>
</div>`;
    return page("Settings", body, { admin: true });
  };

  app.get("/settings", (c) => c.html(render()));

  app.post("/settings", async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string>;
    try {
      applySettings(baseDir, {
        mode: b.mode === "mainnet" ? "mainnet" : b.mode === "testnet" ? "testnet" : undefined,
        payToTestnet: b.payToTestnet,
        payToMainnet: b.payToMainnet,
        cdpApiKeyId: b.cdpApiKeyId,
        cdpApiKeySecret: b.cdpApiKeySecret,
        facilitatorUrl: b.facilitatorUrl,
      });
      return c.html(render("Settings written to .env — restart the server to apply."));
    } catch (err) {
      return c.html(render(undefined, (err as Error).message), 400);
    }
  });

  return app;
}
