# x402sandbox

**by [realandworks.com](https://realandworks.com)**

Self-hostable [x402](https://x402.org) payment gateway: **make any file or folder sellable for USDC** in minutes. No accounts, no card processor, no platform cut — the HTTP `402 Payment Required` exchange *is* the checkout, so human buyers and AI agents pay the same way, and revenue settles straight to your own wallet.

## What you get

- **Web-first operation** — add products (folder or single file, with upload), manage files, remove products, flip networks: all from the admin UI. The CLI and `products.json` remain as escape hatches, never requirements.
- **Drop-in folders** — one folder = one price; every file dropped in (via web upload or filesystem) is instantly listed and purchasable, removing it instantly delists. No restarts.
- **Fixed or demand pricing** — demand mode self-adjusts between your floor and ceiling based on sales, with a grace window so in-flight quotes never fail.
- **Per-request analytics** — every hit is one SQLite row; the dashboard shows the 402→200 conversion funnel, not just totals. Sales export as CSV.
- **Public storefront + sales feed** — styled, light/dark, self-contained (no CDN, no external requests); `catalog.json` and opt-in content excerpts for agent buyers; opt-in listing in x402 discovery registries.
- **Two-channel wallet config** — separate testnet and mainnet receive addresses that can never mix; a settings page with a restart-pending banner and a graceful **Restart server now** button.
- **Agent-installable** — a declarative config provisions a working gateway headlessly (`--json` output, idempotent, secrets via env only).
- **Built-in developer docs** at `/docs` — every install serves its own documentation.

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
- Binds `127.0.0.1` only

## Status

Tier 1 complete: 204 tests, live-verified end to end with settled Base-Sepolia purchases (buy → on-chain settlement → feed/stats/CSV). Interactive setup wizard and `npx create-x402-sandbox` packaging are next (Tier 1.5 / Tier 2).

## Credits

- Verify/settle wiring pattern from [dabit3/x402-starter-kit](https://github.com/dabit3/x402-starter-kit) (MIT)
- Stats/data-model layout inspired by [Fewsats/proxy402](https://github.com/Fewsats/proxy402) (design inspiration only; independent TypeScript implementation)
- Built on [`@x402/hono`](https://www.npmjs.com/package/@x402/hono) and [Hono](https://hono.dev)

## License

MIT
