import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const url = process.argv[2];
const signer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);

const loggingFetch = async (input, init) => {
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers ?? {});
  const xp = headers.get("payment-signature");
  if (xp) console.log("PAYMENT_HEADER=" + xp);
  const res = await fetch(input, init);
  console.log("<<", res.status);
  return res;
};

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(loggingFetch, client);

try {
  const res = await payFetch(url);
  console.log("final:", res.status);
} catch (e) {
  console.log("THREW:", e.constructor?.name, e.message);
  if (e.cause) console.log("cause:", e.cause);
}