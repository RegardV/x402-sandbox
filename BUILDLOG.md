# Build log

The honest record of building x402sandbox: the walls we hit turning an HTTP status code into a working store, how we got past them, and what the protocol's newness forced us to discover the hard way. This gateway sold the **first real dollar** over x402 — and every bug below stood between us and that dollar.

Everything here was proven by a **real paying client settling a real payment on-chain**, first on Base Sepolia testnet, then on Base mainnet. Nothing counted as working until money moved.

---

## The road to the first mainnet sale

Selling to agents worked in testing almost immediately. Then we tried to buy from our own store as a *human*, with a real wallet, real USDC, on mainnet — and hit four failures in a row, none of them documented anywhere.

### 1. The facilitator that wouldn't answer a 402
**Symptom:** the resource server threw "Facilitator does not support exact…" and never issued a challenge.
**Cause:** `x402ResourceServer` must have `initialize()` called (it fetches `getSupported`) *before* it can emit 402s. The order isn't obvious from the types.
**Fix:** an explicit init step in the app lifecycle, with a test stub facilitator.

### 2. The mixed-content wall behind the tunnel
**Symptom:** the browser paywall spun, then "Failed to fetch." No error, no hint.
**Cause:** the gateway runs behind a Cloudflare Tunnel that terminates TLS and forwards plain HTTP. The payment SDK built the retry URL from what the origin saw — `http://`. An HTTPS page fetching an `http://` URL is silently refused by the browser.
**Fix:** honor `X-Forwarded-Proto` and rewrite resource URLs to `https://` (`proxyAwareFetch`). One header, invisible failure.

### 3. The description that was too good to sell
**Symptom:** everything fixed, signature cryptographically valid (we verified it on-chain against the smart-wallet contract by hand) — and Coinbase's own facilitator still rejected the payment with `"paymentPayload is invalid"`.
**Cause:** the product **description**, embedded in the payment payload, exceeded roughly **256 characters**. The CDP facilitator rejects the entire payload over an undocumented length limit. We found the exact number by binary-searching the API with a real signed payment: 512 chars failed, short passed.
**Fix:** cap quoted descriptions at 250 chars at the source. Coinbase's SDK happily *produces* payloads Coinbase's facilitator *refuses*.

### 4. The empty wallet that said "insufficient funds"
**Symptom:** a funded wallet, and yet "insufficient funds."
**Cause:** the "Sign in with Coinbase" flow quietly creates and connects a *brand-new smart wallet* with a zero balance, while the funded wallet sits in the app you thought you'd connected. The error was true — about the wrong wallet.
**Fix:** documentation, not code — but it cost hours, and it's now written down for every operator.

Then the dollar settled on-chain. The tenacity was in refusing to accept "Failed to fetch" as an answer.

---

## Bugs that were invisible until we looked

### Payment rejections were silent
Early on, a failed verify or settle just… didn't deliver. No log, no reason. We added full verify/settle failure logging (`onVerifyFailure`/`onSettleFailure`) surfacing the error, its cause, and the facilitator's response body — plus a `PAYMENT_DEBUG` mode that logs the outbound verify body. **Every diagnosis above depended on this.** Observability of the money path is not optional; it's the first thing to build, not the last.

### The header the SDK renamed
`@x402/fetch` ≥ 2.18 sends the payment in a **`payment-signature`** header, not `X-PAYMENT`. Our redelivery middleware still checked only `x-payment` — so a current-SDK buyer's *paying* request looked *unpaid*, and if their IP had bought the same URL recently, it was diverted to free re-delivery instead of settling. A buyer-friendly bug that silently ate repeat sales. Now both header names are honored.

### HEAD probes paid for nothing
Coinbase's paywall sends a `HEAD` request to probe a resource before paying. Our router 404'd it (no HEAD handler), breaking the flow. Fix: normalize `HEAD` → `GET` for matching and answer probes with headers only, no payment.

### The 37MB PDF that settled but never arrived
A large-file purchase settled on-chain, then the browser widget choked delivering the bytes *after* the money moved. This taught the redelivery grace (below) — and the deeper lesson that **agents don't buy PDFs, they buy answers**, which spun off the packager as a separate product.

---

## Things that fought back

### Self-restart under a TypeScript loader
The admin "Restart server" button respawns the process. Under `tsx`, the child crashed — `tsx` rewrites `argv[1]` to the compiled `.ts` path, so a naive respawn re-exec'd the wrong thing. Fix: respawn as `node --import tsx …argv.slice(1)`, with the config env keys stripped so the child re-reads them fresh. Also: under systemd, "restart" is `exit(0)` + `Restart=always`, not a self-respawn at all — the two paths are detected and handled differently.

### Boot dying on someone else's outage
The gateway died at startup — twice — because the testnet facilitator (x402.org) had a transient blip during `initialize()`. Fix: retry the facilitator init with backoff (`[2s, 4s, 8s, 16s, 30s]`) so a third-party hiccup doesn't take the store down.

### Replayed payments can't be retried
When a download fails *after* settlement, the buyer can't just re-send the payment — the facilitator rejects it (the on-chain nonce is spent). Redelivery had to be application-level: a prior payer's unpaid re-request for the same URL within a window is served free (`x-redelivery` header), never re-charged.

### The lockout that never locked
The admin login lockout used `lockedUntil <= now` to mean "expired" — but the initial value `0` also satisfied that, so the counter reset on every attempt and never locked. Fix: `lockedUntil !== 0 && lockedUntil <= now`. Also, Hono's `basicAuth` *throws* a 401 `HTTPException` rather than returning it, so the lockout middleware had to catch thrown exceptions, not just inspect return values.

### Filenames with spaces broke routing
A single-file product whose name contained spaces produced a route that failed x402's `"<METHOD> /path"` match. Fix: dash out whitespace in generated route paths.

### The catalog that crashed on its own products
Adding the `proxyUrl` product type (resell any endpoint) crashed the catalog page: it called `resolve(baseDir, undefined)` because proxy products have no file path. Fix: a proxy branch that lists by URL, no filesystem.

### Caching is where it all leaks
A cached 402 breaks buying; a cached 200 leaks paid content. Every product response sends `no-store`; behind the tunnel, an ingress rule blocks `/admin` from the public internet entirely.

---

## Process scars

- **We fabricated task-graph statuses once** — marked nodes "done" before executing them. Caught immediately and rewritten to honest pending state. The lesson stuck: a plan that lies about its own progress is worse than no plan.
- **A `sed`-based edit mangled the admin header** — duplicated links, dropped the settings gear. The operator caught it before we did. Hand-edited and pinned with a regression test. Bulk text-surgery on markup is a false economy.
- **Operator data was almost committed** — `products.json` and the `content/` directory belong to the operator, not the repo. Untracked before the mistake shipped; the repo carries an `.example` template instead. (When we later went public, `git-filter-repo` scrubbed a 41MB PDF and real product files out of the entire history.)

---

## What made it tractable

A **real paying client** (`scripts/buy.mjs`, an independent `@x402/fetch` buyer with a funded testnet wallet) gated every feature — not mocks. It caught the `payment-signature` rename, the HEAD-probe gap, the mixed-content wall, and every wrong assumption about a protocol whose spec lags its SDK. The full test suite (250+ tests across config, db, handlers, admin, docs) covers the WordPress-free logic; the money path is proven by settlement.

The single most important discovery of the whole build: **build the money-path observability first.** Every hard bug above was invisible until we logged the facilitator's actual response — and trivial to fix once we could see it.
