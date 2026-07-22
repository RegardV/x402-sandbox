<p align="center">
  <a href="https://x402.inkypyrus.com"><img src="assets/banner.jpg" alt="x402sandbox" width="760"></a>
</p>

# x402sandbox

**by [realandworks.com](https://realandworks.com)**

Self-hostable [x402](https://x402.org) payment gateway: **make any file, folder, or endpoint sellable for USDC** in minutes. No accounts, no card processor, no platform cut — the HTTP `402 Payment Required` exchange *is* the checkout, so human buyers and AI agents pay the same way, and revenue settles straight to your own wallet. Running in production at [x402.inkypyrus.com](https://x402.inkypyrus.com) with settled mainnet sales.

## What you get

- **Web-first operation** — two clean add-product flows (folder with multi-select files, or single file), full file management (upload, rename, in-browser text editing, delete, per-file sales counts), remove products, flip networks, restart the server: all from the admin UI. The CLI and `products.json` remain as escape hatches, never requirements.
- **Drop-in folders** — one folder = one price; every file dropped in (via web upload or filesystem) is instantly listed and purchasable, removing it instantly delists. No restarts.
- **Proxy products (`proxyUrl`)** — paywall any live http(s) endpoint: the gateway sells (402, verify, settle, log), the upstream serves. Forwards method, body, query, and subpath; streams responses. Powers query-style products like a paid retrieval "front desk" (see [x402-packager]) where agents `POST /ask` and get cited passages per query.
- **Human capture forms (`humanForm`)** — parameterized products declare their inputs as data and the storefront renders a real form (text, select, month-dropdown), so a human can buy an endpoint that needs arguments: submit → paywall fires with the params in the query → wallet modal → same-origin retry. Agents keep calling the same URL directly.
- **Paid-but-not-delivered protection** — a settled purchase grants the same buyer a free re-fetch of that URL for `REDELIVERY_MINUTES` (default 60): "click again", never "pay again".
- **Fixed or demand pricing** — demand mode self-adjusts between your floor and ceiling based on sales, with a grace window so in-flight quotes never fail.
- **Per-request analytics** — every hit is one SQLite row; the dashboard shows the 402→200 conversion funnel, not just totals. Sales export as CSV.
- **Public storefront + sales feed** — styled, light/dark, self-contained (no CDN, no external requests); `catalog.json` and opt-in content excerpts for agent buyers; opt-in listing in x402 discovery registries.
- **Two-channel wallet config** — separate testnet and mainnet receive addresses that can never mix; a settings page with a restart-pending banner and a graceful **Restart server now** button.
- **Agent-installable** — a declarative config provisions a working gateway headlessly (`--json` output, idempotent, secrets via env only).
- **Built-in developer docs** at `/docs` — every install serves its own documentation, including the buyer traps we hit selling for real (wallet-connect flows, the QR handoff, CDP's undocumented ~256-char description limit).

## Quick start (testnet — no real money, no signup)

```bash
npm install
cp .env.example .env   # set PAY_TO, ADMIN_PASSWORD, IP_SALT
npm start
# → store  http://127.0.0.1:8402/catalog
# → admin  http://127.0.0.1:8402/admin
# → docs   http://127.0.0.1:8402/docs
```

Headless / agent install:

```bash
echo '{"devWallet": true, "products": [
  {"sku":"lib","title":"Library","price":"$0.01","route":"GET /lib/*","contentDir":"./content/lib"}
]}' > setup.json
X402_ADMIN_PASSWORD=a-long-admin-password npm run setup -- --config setup.json --json
```

Test a purchase (fund the buyer wallet with free Base-Sepolia USDC from [faucet.circle.com](https://faucet.circle.com)):

```bash
BUYER_PRIVATE_KEY=0x... node scripts/buy.mjs http://127.0.0.1:8402/lib/guide.md
```

## Going live

Mainnet needs a free Coinbase CDP Secret API Key (facilitator auth only — it can't touch funds) and a self-custody receive wallet. The flip is a setting: ⚙ Settings → mainnet address + CDP keys → Mainnet → restart. Full walkthrough in `/docs/networks`. Expose the gateway through a tunnel (e.g. a Cloudflare Tunnel ingress — no static IP needed); keep `/admin` off the tunnel.

## Security posture

- Serving confined to content directories: realpath containment (traversal **and** symlink escapes), dot-segment and secret-extension denies — uploads pass the same rules
- Missing files 404 **before** the payment challenge — a buyer can never pay for nothing
- No hot key on the server: the gateway holds only your receiving *address*
- Raw IPs never stored (salted hash); full payer addresses only behind admin auth
- Config writes validated-before-write, atomic, audited; generated dev wallets are refused as mainnet receivers
- Admin brute-force lockout (5 fails → 15 min, per source); request log auto-pruned after `RETENTION_DAYS` (settlements ledger permanent)
- `cache-control: no-store` on product paths — edge caches can't serve a stale 402 or leak content
- Binds `127.0.0.1` only — expose via a tunnel with `/admin` blocked at the ingress

## Status

Running in production on Base mainnet behind a Cloudflare Tunnel (systemd-managed): 250 tests, settled real-money sales verified end to end (smart-wallet buyer → CDP facilitator → on-chain USDC → ledger/feed/CSV), plus a live agent-native retrieval product (`POST /ask`, $0.02/query) proxied to a brains-only [x402-packager] service. Next: interactive setup wizard (Tier 1.5), `npx create-x402-sandbox` packaging and repo scrub (Tier 2).

[x402-packager]: https://github.com/RegardV/x402-packager

## Build log

x402 has no settled spec — its wire format lags its SDK, and the money path fails in ways nothing documents. **[BUILDLOG.md](BUILDLOG.md)** is the honest record of getting to the first real dollar: the four undocumented failures between a valid signature and a settled payment (a mixed-content wall behind the tunnel, an empty smart-wallet trap, an ~256-char description limit found by binary-searching Coinbase's facilitator, an SDK header rename), the bugs that were invisible until we logged the facilitator's actual response, and why the first lesson of any payment integration is *build the money-path observability first*. Worth reading before you integrate x402 anywhere.

## Credits

- Verify/settle wiring pattern from [dabit3/x402-starter-kit](https://github.com/dabit3/x402-starter-kit) (MIT)
- Stats/data-model layout inspired by [Fewsats/proxy402](https://github.com/Fewsats/proxy402) (design inspiration only; independent TypeScript implementation)
- Built on [`@x402/hono`](https://www.npmjs.com/package/@x402/hono) and [Hono](https://hono.dev)

## License

MIT
