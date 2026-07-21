import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
const signer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch(process.argv[2]); // GET
console.log("status:", res.status);
const r = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
if (r) console.log("receipt:", JSON.stringify(decodePaymentResponseHeader(r)));
console.log("body:", (await res.text()).slice(0, 400));
