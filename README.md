# x402-sandbox

Self-hostable [x402](https://x402.org) payment gateway: **make any file, folder, or endpoint sellable** for USDC in one config file. No accounts, no checkout — the HTTP `402 Payment Required` exchange *is* the checkout, so human buyers and AI agents pay the same way.

## What it does

- **Config-driven catalog** — `products.json` defines what's for sale; the gateway mints one paid route per entry at boot. Products are data, not code.
- **Drop-in folders** — a `contentDir` product sells a whole directory at one price: drop a file in and it's instantly listed and purchasable; remove it and it delists. No restart, no config edit.
- **Per-request traffic log** — every hit is one SQLite row (`unpaid_402` / `paid_200` / `error`), so you can see your 402→200 conversion funnel, not just totals.
- **Admin stats page** (`/admin`, Basic auth) — products, sales, requests, conversion.
- **Public feed** (`/feed`) — recent sales with truncated payer addresses, for storefront social proof.
- **Hot reload** — edit `products.json` and the catalog swaps live.

## Quick start (testnet, no real money)

```bash
npm install
cp .env.example .env   # set PAY_TO (any address you control), ADMIN_PASSWORD, IP_SALT
npm start
# → http://127.0.0.1:8402/catalog
```

Defaults are Base Sepolia + the free auth-less `x402.org` facilitator — no signup needed. A buyer pays with [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) and testnet USDC.

## products.json

```json
{
  "products": [
    {
      "sku": "guide", "title": "The Guide", "price": "$0.05",
      "route": "GET /files/guide.pdf", "contentPath": "./content/guide.pdf",
      "mimeType": "application/pdf"
    },
    {
      "sku": "library", "title": "Whole Library", "price": "$0.01",
      "route": "GET /library/*", "contentDir": "./content/library"
    }
  ]
}
```

Exactly one of `contentPath` / `bundlePath` / `contentDir` per product. Directory routes must end in `/*`. `payTo` is never in the catalog — it comes from `.env`.

## Security posture

- Serving is confined to the configured content directories: realpath containment (traversal **and** symlink escapes), dot-segment deny (`.env`, `.git/…`), secret-extension deny (`*.env`, `*.key`, `*.pem`).
- Missing files 404 **before** the payment challenge — a buyer can never pay for a file that doesn't exist.
- Raw client IPs are never stored (salted hash only). Full payer addresses are visible only behind admin auth; the public feed truncates them.
- Binds `127.0.0.1` only — expose via a tunnel (e.g. a Cloudflare Tunnel ingress hostname); keep `/admin` off the tunnel.

## Status

Tier 0 (working core, testnet-first). Planned: setup wizard, admin CRUD, demand pricing, headless/agent install, `npx create-x402-sandbox`. Mainnet requires a CDP facilitator config (not wired yet — testnet only for now).

## Credits

- Verify/settle wiring pattern from [dabit3/x402-starter-kit](https://github.com/dabit3/x402-starter-kit) (MIT).
- Stats/data-model layout inspired by [Fewsats/proxy402](https://github.com/Fewsats/proxy402) (design inspiration only; independent TypeScript implementation).
- Built on [`@x402/hono`](https://www.npmjs.com/package/@x402/hono) and [Hono](https://hono.dev).

## License

MIT
