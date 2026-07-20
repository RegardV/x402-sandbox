// Spend cap — the money-protection layer, provider-agnostic. Even with a custodied
// key, a compromised agent can drain the wallet; this bounds the loss per session.
// (On-chain equivalent for option 4 is a CDP spend permission — see signer.mjs.)
export function createBudget({ maxMicroUsdc, maxCalls = Infinity }) {
  let spent = 0;
  let calls = 0;
  return {
    // Called before each paid request; throws if this purchase would breach the cap.
    authorize(amountMicro) {
      if (calls + 1 > maxCalls) {
        throw new Error(`budget: call limit reached (${maxCalls})`);
      }
      if (spent + amountMicro > maxMicroUsdc) {
        throw new Error(`budget: $${(spent / 1e6).toFixed(2)} spent, $${(amountMicro / 1e6).toFixed(2)} more exceeds cap $${(maxMicroUsdc / 1e6).toFixed(2)}`);
      }
      spent += amountMicro;
      calls += 1;
    },
    report: () => ({ spentUsdc: spent / 1e6, calls }),
  };
}
