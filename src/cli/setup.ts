// Headless/agent install entry: npm run setup -- --config setup.json [--json]
// Secrets via env (X402_ADMIN_PASSWORD), never flags. Exit 0 ok, 1 invalid, 2 prereqs failed.
import { readFileSync } from "node:fs";
import { checkPrereqs, nextSteps } from "./checks.js";
import { runHeadless, type HeadlessConfig } from "./headless.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const configIdx = args.indexOf("--config");
const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

const out = (o: unknown, text: string) => console.log(json ? JSON.stringify(o, null, 2) : text);

const prereqs = checkPrereqs(process.cwd());
if (!prereqs.ok) {
  out(prereqs, prereqs.checks.filter((c) => !c.ok && c.required).map((c) => `MISSING: ${c.name} — ${c.detail}`).join("\n"));
  process.exit(2);
}

let config: HeadlessConfig = {};
if (configPath) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as HeadlessConfig;
  } catch (err) {
    out({ ok: false, error: `config file: ${(err as Error).message}` }, `config file: ${(err as Error).message}`);
    process.exit(1);
  }
}

const { exitCode, result } = runHeadless(process.cwd(), config, process.env);
if (result.ok) {
  const steps = nextSteps({
    port: config.port ?? 8402,
    network: config.network ?? "eip155:84532",
    payTo: result.payTo!,
    devWallet: result.devWalletKeyFile ? result.payTo : undefined,
  });
  out({ ...result, nextSteps: steps }, `provisioned ✔\n${result.warnings.join("\n")}\n\n${steps}`);
} else {
  out(result, `setup failed: ${result.error}`);
}
process.exit(exitCode);
