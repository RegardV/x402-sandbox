// The agent loop: Hermes decides, the shopper tool pays. Tool isolation means only
// the shopper agent carries the paying tool — a plain chat agent gets none.
//
// Usage:
//   HERMES_URL=http://localhost:11434/v1  HERMES_MODEL=hermes3 \
//   X402_ENDPOINT=http://localhost:8093/wp-json/x402/v1/ask/k8s \
//   KEYSTORE=./shopper.keystore  KEYSTORE_PASS=... \
//   node scripts/agent/run.mjs "why do pods get evicted under memory pressure?"
import { keystoreSigner, cdpServerSigner } from "./signer.mjs";
import { createBudget } from "./budget.mjs";
import { createShopperAgent } from "./shopper.mjs";

const question = process.argv.slice(2).join(" ") || "what does the kube-scheduler do?";

// --- wallet: keystore now (testnet), CDP server wallet for option 3 ---
const signer = process.env.CDP_API_KEY_ID
  ? await cdpServerSigner({ accountName: process.env.CDP_ACCOUNT ?? "x402-shopper" })
  : keystoreSigner({ path: process.env.KEYSTORE, passphrase: process.env.KEYSTORE_PASS });

// --- the shopper profile: the ONLY thing holding the wallet + paying tool ---
const shopper = createShopperAgent({
  signer,
  budget: createBudget({ maxMicroUsdc: Number(process.env.MAX_SPEND_MICRO ?? 100_000), maxCalls: Number(process.env.MAX_CALLS ?? 20) }),
  endpoint: process.env.X402_ENDPOINT,
  toolName: "ask_knowledge",
  toolDescription: "Buy cited answers (per-query USDC) from a paid knowledge endpoint. Use for questions the base model can't answer confidently.",
});

// --- Hermes loop over an OpenAI-compatible endpoint ---
const HERMES = process.env.HERMES_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.HERMES_MODEL ?? "hermes3";

async function chat(messages) {
  const r = await fetch(`${HERMES}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.HERMES_KEY ?? "ollama"}` },
    body: JSON.stringify({ model: MODEL, messages, tools: shopper.tools, tool_choice: "auto" }),
  });
  if (!r.ok) throw new Error(`Hermes ${r.status}: ${await r.text()}`);
  return (await r.json()).choices[0].message;
}

const messages = [
  { role: "system", content: "You are a research assistant. You have one paid tool, ask_knowledge, that buys cited passages from a knowledge base. Call it when a question needs specific facts you're unsure of, then answer citing the sources it returns." },
  { role: "user", content: question },
];

for (let hop = 0; hop < 5; hop++) {
  const msg = await chat(messages);
  messages.push(msg);
  if (!msg.tool_calls?.length) {
    console.log("\n=== answer ===\n" + msg.content);
    console.log("\nspend:", shopper.budget.report());
    break;
  }
  for (const call of msg.tool_calls) {
    const args = JSON.parse(call.function.arguments || "{}");
    console.log(`[shopper] paying for: ${args.question}`);
    let result;
    try {
      result = await shopper.runToolCall(call.function.name, args);
      console.log(`[shopper] settled tx ${result._paid_tx ?? "(cached)"}`);
    } catch (e) {
      result = { error: String(e.message) }; // budget breach / failure → tell the model
      console.log(`[shopper] refused: ${e.message}`);
    }
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}
