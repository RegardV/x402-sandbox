// Self-test the shopper WITHOUT an LLM: keystore round-trip, spend-cap enforcement,
// tool isolation, and a real testnet purchase through the paying tool.
// Usage: BUYER_PRIVATE_KEY=0x... X402_ENDPOINT=... node scripts/agent/selftest.mjs
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeKeystore } from "./keystore.mjs";
import { keystoreSigner } from "./signer.mjs";
import { createBudget } from "./budget.mjs";
import { createShopperAgent, budgetedFetch } from "./shopper.mjs";

// 1. keystore: no plaintext key on disk, round-trips under the passphrase.
const dir = mkdtempSync(join(tmpdir(), "ks-"));
const ksPath = join(dir, "k.json");
writeKeystore(ksPath, process.env.BUYER_PRIVATE_KEY, "correct horse");
const signer = keystoreSigner({ path: ksPath, passphrase: "correct horse" });
assert.match(signer.address, /^0x[0-9a-fA-F]{40}$/);
assert.throws(() => keystoreSigner({ path: ksPath, passphrase: "wrong" }), "wrong passphrase must fail");
console.log("✓ keystore seals + opens; wrong passphrase rejected");

// 2. spend cap: authorizes under the cap, throws over it.
const b = createBudget({ maxMicroUsdc: 30_000, maxCalls: 3 });
b.authorize(20_000);
assert.throws(() => b.authorize(20_000), "should refuse over-cap");
console.log("✓ budget authorizes under cap, refuses over");

// 3. budget interception aborts a payment BEFORE it is sent (deterministic, no network).
// A crafted payment-signature header authorizing $0.05; the paid request must never fire.
const payHeader = btoa(JSON.stringify({ payload: { authorization: { value: "50000" } } }));
let baseCalled = false;
const stub = async () => { baseCalled = true; return new Response("{}"); };
const overCap = budgetedFetch(stub, createBudget({ maxMicroUsdc: 10_000 })); // $0.01 cap < $0.05
await assert.rejects(() => overCap("http://x", { headers: { "payment-signature": payHeader } }), /budget/);
assert.equal(baseCalled, false, "over-budget payment must NOT be sent");
// Under the cap it goes through; a request with no payment header is never budgeted.
const underCap = budgetedFetch(stub, createBudget({ maxMicroUsdc: 100_000 }));
await underCap("http://x", { headers: { "payment-signature": payHeader } });
assert.equal(baseCalled, true, "in-budget payment should be sent");
await budgetedFetch(async () => new Response("ok"), createBudget({ maxMicroUsdc: 0 }))("http://x", {}); // no header, $0 cap, still fine
console.log("✓ budget aborts over-cap payment before it is sent; passes under cap; free requests unbudgeted");

// 4. tool isolation: the shopper exposes exactly one named tool; unknown tools throw.
const shopper = createShopperAgent({
  signer,
  budget: createBudget({ maxMicroUsdc: 50_000 }),
  endpoint: process.env.X402_ENDPOINT,
});
assert.equal(shopper.tools.length, 1);
assert.equal(shopper.tools[0].function.name, "ask_knowledge");
await assert.rejects(() => shopper.runToolCall("some_other_tool", {}), /no tool/);
console.log("✓ shopper carries one isolated tool; foreign tool calls rejected");

// 4. real testnet purchase through the tool (proves the whole paid path).
if (process.env.X402_ENDPOINT) {
  const out = await shopper.runToolCall("ask_knowledge", { question: "what does the scheduler do", top_k: 2 });
  assert.ok(Array.isArray(out.results), "expected results array");
  console.log(`✓ paid tool call settled tx ${out._paid_tx}; ${out.results.length} passages; spend`, shopper.budget.report());
}
console.log("\nALL SELF-TESTS PASSED");
