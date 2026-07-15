import { generateDevWallet, provision, type ProvisionAnswers } from "../provision.js";

/** Declarative install config — the wizard's answers as data. Secrets are NOT
 *  allowed here; they come from the environment (X402_ADMIN_PASSWORD). */
export interface HeadlessConfig {
  payTo?: string;
  devWallet?: boolean; // generate a testnet dev wallet as payTo
  network?: string;
  facilitatorUrl?: string;
  port?: number;
  products?: Array<Record<string, unknown>>;
}

export interface HeadlessResult {
  ok: boolean;
  wroteEnv: boolean;
  wroteProducts: boolean;
  payTo?: string;
  devWalletKeyFile?: string;
  warnings: string[];
  error?: string;
}

/** Non-interactive install: config object in, JSON-serializable result out.
 *  Exit codes: 0 ok (including idempotent no-op), 1 invalid config/env. */
export function runHeadless(
  targetDir: string,
  config: HeadlessConfig,
  env: Record<string, string | undefined>,
): { exitCode: number; result: HeadlessResult } {
  const failed = (error: string): { exitCode: number; result: HeadlessResult } => ({
    exitCode: 1,
    result: { ok: false, wroteEnv: false, wroteProducts: false, warnings: [], error },
  });

  if ("adminPassword" in config || "ipSalt" in config) {
    return failed("secrets must come from the environment (X402_ADMIN_PASSWORD), never the config file");
  }
  const adminPassword = env["X402_ADMIN_PASSWORD"];
  if (!adminPassword) return failed("X402_ADMIN_PASSWORD environment variable is required");

  let payTo = config.payTo;
  let devWalletKeyFile: string | undefined;
  if (config.devWallet) {
    if ((config.network ?? "eip155:84532") === "eip155:8453") {
      return failed("devWallet is testnet-only — a generated key must never receive mainnet funds");
    }
    if (!payTo) {
      const w = generateDevWallet(targetDir);
      payTo = w.address;
      devWalletKeyFile = `${targetDir}/.dev-wallet.env`;
    }
  }
  if (!payTo) return failed("config needs payTo (or devWallet:true on testnet)");

  const answers: ProvisionAnswers = {
    payTo,
    network: config.network,
    facilitatorUrl: config.facilitatorUrl,
    port: config.port,
    adminPassword,
    products: config.products,
  };
  try {
    const r = provision(targetDir, answers);
    return {
      exitCode: 0,
      result: {
        ok: true,
        wroteEnv: r.wroteEnv,
        wroteProducts: r.wroteProducts,
        payTo,
        ...(devWalletKeyFile ? { devWalletKeyFile } : {}),
        warnings: r.warnings,
      },
    };
  } catch (err) {
    return failed((err as Error).message);
  }
}
