// Pluggable signer. The x402 payment is an EIP-712 typed-data signature, and the
// SDK's signer is just a viem Account — so anything that can signTypedData plugs in.
// The private key never reaches Hermes (the LLM) in ANY of these; it lives only here.
import { privateKeyToAccount } from "viem/accounts";
import { readKeystore } from "./keystore.mjs";

/**
 * Option 1 — encrypted keystore (runnable now, testnet-friendly).
 * Key sealed on disk with a passphrase, decrypted in memory at startup.
 */
export function keystoreSigner({ path, passphrase }) {
  const pk = readKeystore(path, passphrase);
  return privateKeyToAccount(pk); // viem LocalAccount → x402 signer
}

/**
 * Option 3 — CDP server wallet (remote signer). The key is custodied by Coinbase;
 * the agent has PERMISSION TO REQUEST SIGNATURES, not the key. Same CDP credentials
 * you already use for the facilitator. Attach a CDP policy to cap/allowlist it.
 *
 * Requires: @coinbase/cdp-sdk, CDP_API_KEY_ID/SECRET in env, an account funded with USDC.
 */
export async function cdpServerSigner({ accountName = "x402-shopper" } = {}) {
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient(); // reads CDP_API_KEY_ID / CDP_API_KEY_SECRET
  const account = await cdp.evm.getOrCreateAccount({ name: accountName });
  // account exposes address + signTypedData + signMessage — a viem-compatible signer.
  return account;
}

/**
 * Option 4 — bounded, revocable authority via a CDP spend permission. A smart account
 * grants the shopper (spender) the right to spend at most `allowanceUsdc` of USDC per
 * period. Blast radius is the allowance, not the wallet; revoke to cut it off.
 * This mints the on-chain permission; the shopper then signs within it.
 */
export async function createSpendPermission({ ownerSmartAccount, spender, allowanceUsdc, periodInDays = 1, network = "base-sepolia" }) {
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient();
  return cdp.evm.createSpendPermission({
    spendPermission: {
      account: ownerSmartAccount, // the funded smart account
      spender,                    // the agent's session address
      token: "usdc",
      allowance: BigInt(Math.round(allowanceUsdc * 1e6)),
      periodInDays,
    },
    network,
  });
}
