// The SHOPPER AGENT profile. Tool isolation lives here: the payment tool and the
// wallet signer are constructed INSIDE this factory, so only the shopper agent can
// pay. A general assistant built without calling this simply has no paying tool.
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

/**
 * Wrap a fetch so any request carrying an x402 payment header is cleared against the
 * budget FIRST — reading the amount from the signed authorization — and aborted if it
 * would breach the cap. This is the money-moving request, so the cap is real, not advisory.
 */
export function budgetedFetch(baseFetch, budget) {
  return async (input, init) => {
    const req = new Request(input, init);
    const header = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
    if (header) {
      let amount = NaN;
      try {
        amount = Number(JSON.parse(atob(header))?.payload?.authorization?.value);
      } catch { /* fall through to the NaN guard */ }
      if (!Number.isFinite(amount)) throw new Error("budget: could not read payment amount — refusing to pay blind");
      budget.authorize(amount); // throws before the paid request is sent
    }
    return baseFetch(req);
  };
}

/**
 * Build a shopper agent bound to one signer + one spend budget + one endpoint.
 * Returns { tools, runToolCall } — the ONLY surface that can spend money.
 *
 * @param signer    a viem-compatible account (keystore / CDP server / spend-permission)
 * @param budget    from createBudget(): the per-session spend cap
 * @param endpoint  the x402 ask URL, e.g. https://your-site/wp-json/x402/v1/ask/k8s
 */
export function createShopperAgent({ signer, budget, endpoint, toolName = "ask_knowledge", toolDescription }) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  // Budget is enforced on the PAID retry itself: the request carrying the payment
  // header is the only one that moves money, so we read its authorized amount and
  // clear the cap before letting it go out. Redelivery (no payment header) passes
  // through free and never touches the budget.
  const payFetch = wrapFetchWithPayment(budgetedFetch(fetch, budget), client);

  const body = (question, topK) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: question, top_k: topK }),
  });

  async function ask(question, topK = 4) {
    const res = await payFetch(endpoint, body(question, topK));
    if (!res.ok) throw new Error(`ask failed: ${res.status}`);
    const receipt = res.headers.get("payment-response");
    return {
      data: await res.json(),
      tx: receipt ? decodePaymentResponseHeader(receipt).transaction : null,
    };
  }

  // The tool schema handed to Hermes — ONLY the shopper agent includes this.
  const tools = [{
    type: "function",
    function: {
      name: toolName,
      description: toolDescription ?? `Buy cited knowledge (per-query USDC) from a paid endpoint. ${budget ? `Session budget: $${budget.report ? "capped" : ""}.` : ""}`,
      parameters: {
        type: "object",
        properties: { question: { type: "string" }, top_k: { type: "integer" } },
        required: ["question"],
      },
    },
  }];

  async function runToolCall(name, args) {
    if (name !== toolName) throw new Error(`shopper has no tool '${name}'`);
    const { data, tx } = await ask(args.question, args.top_k ?? 4);
    return { ...data, _paid_tx: tx };
  }

  return { tools, runToolCall, ask, budget };
}
