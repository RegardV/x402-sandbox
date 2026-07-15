// Testnet buyer: pays for one URL with x402 and prints the receipt.
// Usage: BUYER_PRIVATE_KEY=0x... node scripts/buy.mjs http://127.0.0.1:8402/demo/article.md
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const url = process.argv[2];
const pk = process.env.BUYER_PRIVATE_KEY;
if (!url || !pk) {
  console.error("usage: BUYER_PRIVATE_KEY=0x... node scripts/buy.mjs <url>");
  process.exit(1);
}

const signer = privateKeyToAccount(pk);
console.log("buyer:", signer.address);

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch(url);
console.log("status:", res.status);
const receiptHeader = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
if (receiptHeader) {
  console.log("receipt:", JSON.stringify(decodePaymentResponseHeader(receiptHeader), null, 2));
}
const body = await res.text();
console.log("body:", body.slice(0, 200));
