// Testnet buyer for POST endpoints: pays for one x402 POST request and prints the receipt.
// Usage: BUYER_PRIVATE_KEY=0x... node scripts/buy-post.mjs <url> '<json-body>'
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const [url, body] = process.argv.slice(2);
const pk = process.env.BUYER_PRIVATE_KEY;
if (!url || !body || !pk) {
  console.error("usage: BUYER_PRIVATE_KEY=0x... node scripts/buy-post.mjs <url> '<json-body>'");
  process.exit(1);
}

const signer = privateKeyToAccount(pk);
console.log("buyer:", signer.address);

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
console.log("status:", res.status);
const receiptHeader = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
if (receiptHeader) {
  console.log("receipt:", JSON.stringify(decodePaymentResponseHeader(receiptHeader), null, 2));
}
console.log("body:", (await res.text()).slice(0, 1200));