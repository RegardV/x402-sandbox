# x402 shopper agent

A reference **agent that autonomously pays for knowledge** over x402. The LLM (e.g. Hermes) decides *when* to buy; a payment tool does the buying. The private key never reaches the model — it lives only in the signer.

## Design

```
Hermes (LLM, tool-calling)  ──decides──▶  shopper agent  ──pays──▶  x402 endpoint
        no wallet, no key                 holds tool+signer         (your WP /ask/{slug})
```

- **Tool isolation** (`shopper.mjs`) — the paying tool and the wallet signer are constructed *inside* `createShopperAgent()`. Only an agent built through it can spend. A plain chat agent built without it has no paying tool. Give the shopper profile the tool; give nothing else money.
- **Spend cap** (`budget.mjs` + `budgetedFetch`) — enforced on the money-moving request itself: the paid retry's authorized amount is read from the signed authorization and cleared against the cap *before* it's sent. Over budget → the payment is aborted, never sent. Free redelivery (no payment header) never touches the budget.
- **Pluggable signer** (`signer.mjs`) — the x402 payment is an EIP-712 signature and the SDK signer is just a viem account, so any backend plugs in.

## Signer options (key custody, weakest → strongest)

| Option | How | Fit |
|---|---|---|
| **Keystore** (`keystoreSigner`) | Key sealed on disk with a passphrase (scrypt + AES-256-GCM), decrypted in memory at startup. No plaintext key, no env key. | Testnet / dev. Runnable now. |
| **CDP server wallet** (`cdpServerSigner`) — *option 3* | Key custodied by Coinbase; agent has *permission to request signatures*, not the key. Same CDP creds as your facilitator. Attach a CDP **policy** to cap/allowlist. | Autonomous mainnet. |
| **CDP spend permission** (`createSpendPermission`) — *option 4* | A funded smart account grants the shopper the right to spend ≤ `allowanceUsdc` of USDC per period. Blast radius = the allowance; revoke to cut off. | Strongest bound for agents. |

The in-process spend cap (`budget.mjs`) is provider-agnostic and stacks with the on-chain bound — belt and suspenders. **The real risk with an autonomous paying agent isn't the key leaking, it's unbounded spend if the host is compromised; a keystore protects the key, a policy/permission protects the money.**

## Run it

```bash
# 1. Seal a wallet key into a keystore (one time) — no plaintext on disk:
node -e 'import("./keystore.mjs").then(k=>k.writeKeystore("./shopper.keystore", process.env.KEY, process.env.PASS))'

# 2. Point Hermes (any OpenAI-compatible endpoint) + the shopper at your endpoint:
HERMES_URL=http://localhost:11434/v1  HERMES_MODEL=hermes3 \
X402_ENDPOINT=http://localhost:8093/wp-json/x402/v1/ask/k8s \
KEYSTORE=./shopper.keystore  KEYSTORE_PASS=...  MAX_SPEND_MICRO=100000 \
node run.mjs "why do pods get evicted under memory pressure?"
```

Switch to the CDP server wallet (option 3) by setting `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` instead of `KEYSTORE` — `run.mjs` picks it automatically.

## Verify without an LLM

`node selftest.mjs` (with `BUYER_PRIVATE_KEY` and optionally `X402_ENDPOINT`) checks the keystore round-trip, that the spend cap aborts an over-budget payment before it's sent, tool isolation, and — against a live testnet endpoint — a real paid tool call.

## Notes

- **Reachability:** the agent must be able to reach the endpoint. Localhost works if it runs on the same box; a remote Hermes needs the store behind a public URL (a tunnel).
- **Network:** testnet first (free). Mainnet spends real USDC per query — that's what the spend cap and CDP policy are for.
