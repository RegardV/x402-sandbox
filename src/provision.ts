import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadEnv, loadProducts } from "./config.js";

export interface ProvisionAnswers {
  payTo: string;
  network?: string;
  facilitatorUrl?: string;
  adminPassword: string;
  ipSalt?: string;
  port?: number;
  products?: Array<Record<string, unknown>>;
}

export interface ProvisionResult {
  wroteEnv: boolean;
  wroteProducts: boolean;
  envPath: string;
  productsPath: string;
  warnings: string[];
}

function atomicWrite(path: string, content: string, mode?: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
  renameSync(tmp, path);
  if (mode !== undefined) chmodSync(path, mode); // rename preserves tmp mode, but be explicit
}

/** Turns validated answers into .env + products.json, idempotently.
 *  Reuses config.ts validators so the rules live in exactly one place. */
export function provision(targetDir: string, answers: ProvisionAnswers): ProvisionResult {
  const envPath = join(targetDir, ".env");
  const productsPath = join(targetDir, "products.json");
  const warnings: string[] = [];

  const envMap: Record<string, string> = {
    PAY_TO: answers.payTo,
    NETWORK: answers.network ?? "eip155:84532",
    FACILITATOR_URL: answers.facilitatorUrl ?? "https://x402.org/facilitator",
    ADMIN_PASSWORD: answers.adminPassword,
    IP_SALT: answers.ipSalt ?? randomBytes(16).toString("hex"),
    ...(answers.port !== undefined ? { PORT: String(answers.port) } : {}),
  };
  loadEnv(envMap); // full rule set incl. mainnet-requires-CDP; throws on violation

  const productsJson =
    answers.products !== undefined
      ? JSON.stringify({ products: answers.products }, null, 2) + "\n"
      : undefined;
  if (productsJson !== undefined) loadProducts(productsJson, targetDir);

  let wroteEnv = false;
  if (existsSync(envPath)) {
    warnings.push(".env already exists — preserved, secrets not overwritten");
  } else {
    const content = Object.entries(envMap)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    atomicWrite(envPath, content + "\n", 0o600);
    wroteEnv = true;
  }

  let wroteProducts = false;
  if (productsJson !== undefined) {
    atomicWrite(productsPath, productsJson);
    wroteProducts = true;
  }

  return { wroteEnv, wroteProducts, envPath, productsPath, warnings };
}

const DEV_WALLET_FILE = ".dev-wallet.env";

/** Testnet-only throwaway wallet; the key never leaves the 600-perm file. */
export function generateDevWallet(targetDir: string): {
  address: `0x${string}`;
  privateKey: `0x${string}`;
} {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  atomicWrite(
    join(targetDir, DEV_WALLET_FILE),
    `# testnet dev wallet — NEVER use on mainnet\nDEV_WALLET_ADDRESS=${address}\nDEV_WALLET_PRIVATE_KEY=${privateKey}\n`,
    0o600,
  );
  return { address, privateKey };
}

/** A wizard-generated key must never receive real funds. */
export function assertNotDevWalletOnMainnet(targetDir: string, network: string, payTo: string): void {
  if (network !== "eip155:8453") return;
  const file = join(targetDir, DEV_WALLET_FILE);
  if (!existsSync(file)) return;
  const recorded = readFileSync(file, "utf8").match(/DEV_WALLET_ADDRESS=(0x[0-9a-fA-F]{40})/)?.[1];
  if (recorded && recorded.toLowerCase() === payTo.toLowerCase()) {
    throw new Error(
      "payTo is a generated dev wallet — refusing to start on mainnet. Use a self-custody address you control.",
    );
  }
}
