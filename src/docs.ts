import { Hono } from "hono";
import { page } from "./ui.js";

/** Developer documentation, served by the gateway itself at /docs.
 *  Content lives here as HTML template strings — no markdown pipeline, no build step. */

const code = (s: string) => `<pre style="background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:.9rem 1.1rem;overflow-x:auto;font-size:.85rem;line-height:1.5"><code>${s.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code></pre>`;

interface DocPage {
  slug: string;
  title: string;
  body: string;
}

const PAGES: DocPage[] = [
  {
    slug: "",
    title: "Overview",
    body: `
<p class="lede">x402-sandbox is a self-hostable payment gateway: it makes files, folders, and endpoints sellable for USDC over plain HTTP using the <a href="https://x402.org">x402 protocol</a>. The HTTP <code>402 Payment Required</code> exchange <em>is</em> the checkout — no accounts, no card processor — so human buyers and AI agents pay the same way.</p>
<h2>How a purchase works</h2>
<ol>
<li>A buyer requests a paid URL, e.g. <code>GET /guides/soil.pdf</code></li>
<li>The gateway answers <code>402</code> with a machine-readable quote (price, receiving wallet, network) in the <code>payment-required</code> header</li>
<li>The buyer's client signs a USDC payment authorization and retries the request with an <code>X-PAYMENT</code> header</li>
<li>A <em>facilitator</em> verifies and settles it on-chain; the gateway serves the content and returns a settlement receipt in the <code>PAYMENT-RESPONSE</code> header</li>
</ol>
<p>The buyer needs no gas — payment authorizations are gasless (EIP-3009); the facilitator sponsors settlement.</p>
<h2>Quick start (testnet, no real money)</h2>
${code(`git clone <repo> && cd x402-sandbox
npm install
cp .env.example .env   # set PAY_TO, ADMIN_PASSWORD, IP_SALT
npm start
# → http://127.0.0.1:8402/catalog`)}
<p>Or headless / agent-driven — a declarative config, no prompts:</p>
${code(`echo '{"devWallet": true, "products": [
  {"sku":"lib","title":"Library","price":"$0.01","route":"GET /lib/*","contentDir":"./content/lib"}
]}' > setup.json
X402_ADMIN_PASSWORD=a-long-admin-password npm run setup -- --config setup.json --json`)}
<p>Exit codes: <code>0</code> ok (idempotent re-runs converge and never clobber secrets), <code>1</code> invalid config, <code>2</code> missing prerequisites. Secrets pass via environment only — never flags, never the config file.</p>
<h2>Architecture in one paragraph</h2>
<p>A single Node process (Hono) reads <code>products.json</code>, mints one paid route per product via <code>@x402/hono</code>'s payment middleware, and serves everything else free: the store (<code>/catalog</code>), the public sales feed (<code>/feed</code>), these docs, and a Basic-auth admin. Every hit writes one row to SQLite (<code>node:sqlite</code> — zero external dependencies); settlements are recorded from the receipt header. The catalog hot-reloads on change; no restart for product edits.</p>`,
  },
  {
    slug: "products",
    title: "products.json",
    body: `
<p class="lede">The catalog is data: one JSON file, one entry per product, validated at load — an invalid catalog is rejected as a whole and the previous one keeps serving.</p>
${code(`{
  "products": [
    {
      "sku": "library",                 // stable key, unique
      "title": "Whole Library",
      "description": "optional — shown on the store and in discovery",
      "price": "$0.01",                 // fixed pricing … OR:
      // "pricing": { "mode": "demand", "floor": "$0.001", "ceiling": "$0.10",
      //              "step": 0.1, "windowMinutes": 15 },
      "route": "GET /library/*",        // "METHOD /path" — wildcard for folders
      "contentDir": "./content/library",// exactly ONE of contentDir | contentPath | bundlePath
      "network": "eip155:84532",        // optional, inherits .env NETWORK
      "mimeType": "text/markdown",      // optional; folders infer per file
      "preview": true,                  // optional: excerpt md/txt on the store
      "discoverable": true              // optional: list in x402 registries (Bazaar)
    }
  ]
}`)}
<h2>Rules the validator enforces</h2>
<ul>
<li>Exactly one of <code>price</code> / <code>pricing</code>, and exactly one of <code>contentPath</code> / <code>bundlePath</code> / <code>contentDir</code></li>
<li><code>contentDir</code> products must use a wildcard route (<code>GET /x/*</code>); file products must not</li>
<li><code>network</code> matches <code>eip155:&lt;chainId&gt;</code>; prices are <code>"$0.05"</code> strings or positive numbers; skus unique</li>
<li>demand pricing: floor &lt; ceiling, step in (0,1), window ≥ 1 minute</li>
</ul>
<h2>Directory products</h2>
<p>One folder = one price. Every file dropped in is instantly listed and purchasable; removing it delists it — no reload. The store page lists directory contents live (dotfiles and secret extensions are never listed or served).</p>
<h2>Demand pricing</h2>
<p>Each window, the repricer counts settled sales: none → price decays by <code>step</code> toward <code>floor</code>; some → it rises toward <code>ceiling</code>. The floor/ceiling bounds are the safety property (quote-spam can manipulate the signal; bounds cap the damage). For one window after a change both old and new price verify, so in-flight quotes never fail. Current price persists in the DB across restarts.</p>
<h2>payTo is never in the catalog</h2>
<p>The receiving wallet and payment scheme come from <code>.env</code> — the catalog is safe to commit and share.</p>`,
  },
  {
    slug: "buying",
    title: "Buying (agents)",
    body: `
<p class="lede">For developers writing buyers — AI agents or scripts that pay for content programmatically.</p>
<h2>Discover</h2>
<p><code>GET /catalog.json</code> returns every product with its price, URL, and (for folders) each purchasable file — including <code>excerpt</code> teasers when the operator enabled previews:</p>
${code(`{ "products": [ { "sku": "library", "title": "Whole Library", "price": "$0.01",
    "route": "GET /library/*",
    "files": [ { "path": "guide.md", "url": "/library/guide.md", "size": 2048,
                 "excerpt": "Soil Regeneration Basics…" } ] } ] }`)}
<p>Products marked <code>discoverable</code> are also announced to x402 discovery registries, so agents can find the store without knowing the URL.</p>
<h2>Pay — with @x402/fetch (TypeScript)</h2>
${code(`import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const signer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://store.example.com/library/guide.md");
const receipt = decodePaymentResponseHeader(res.headers.get("payment-response"));
// receipt = { success: true, payer: "0x…", transaction: "0x…", network: "eip155:…" }`)}
<p>The wallet needs USDC on the gateway's network (testnet: free from <a href="https://faucet.circle.com">faucet.circle.com</a>, Base Sepolia). No ETH needed.</p>
<h2>Pay — raw HTTP (any language)</h2>
<ol>
<li><code>GET</code> the paid URL → <code>402</code>; decode the base64 <code>payment-required</code> response header → JSON with <code>accepts[]</code> (scheme, network, amount in atomic units, asset contract, payTo)</li>
<li>Sign an EIP-3009 <code>transferWithAuthorization</code> for exactly that amount, encode per the x402 spec, retry the request with it in the <code>X-PAYMENT</code> header</li>
<li><code>200</code> + content; the base64 <code>PAYMENT-RESPONSE</code> header carries <code>{ success, payer, transaction, network }</code></li>
</ol>
<p>A missing file 404s <em>before</em> any payment challenge — you can never pay for something that doesn't exist. A repriced product accepts both old and new price for one window, so a quote you just received always verifies.</p>
<h2>Test buyer</h2>
<p>The repo ships one: <code>BUYER_PRIVATE_KEY=0x… node scripts/buy.mjs &lt;url&gt;</code></p>`,
  },
  {
    slug: "admin",
    title: "Operating",
    body: `
<p class="lede">Everything an operator does day-to-day happens in the admin UI at <code>/admin</code> (HTTP Basic auth, user <code>admin</code>, password from <code>.env</code>).</p>
<h2>Products</h2>
<p><strong>+ Add product</strong> asks only what you're selling (a folder or a single file), a title, and a price — the sku, URL route, and content folder are derived and created for you. Single-file products take the upload in the same form. Folder products land on their file page, where every upload is instantly for sale and every delete instantly delists. <strong>remove</strong> takes a product off the store but leaves its files on disk (re-adding restores it).</p>
<h2>Pricing choices</h2>
<p>Fixed, or demand pricing with a floor and ceiling (10% moves on a 15-minute window by default — tune <code>step</code>/<code>windowMinutes</code> in <code>products.json</code>).</p>
<h2>Stats</h2>
<p>The dashboard tiles show revenue, sales, and the 402→200 conversion funnel: <em>paid hits</em> are served purchases, <em>unpaid hits</em> are buyers who saw the price and walked. A low ratio means the price or the pitch is wrong. The requests table shows every hit with its outcome; sales export as CSV for bookkeeping.</p>
<h2>Settings</h2>
<p><code>/admin/settings</code> (the ⚙ gear): network mode, <strong>two separate receive-address channels</strong> (a testnet slot and a mainnet slot — the active network decides which one earns; flipping can never route revenue to the other channel's wallet), CDP keys (never echoed back), facilitator. Changes are validated exactly like startup and written atomically to <code>.env</code>. Until the server restarts, an amber <em>Restart pending</em> banner stays on the page — with a <strong>Restart server now</strong> button that gracefully hands off to a fresh process (response flushes, listener closes, respawn re-reads <code>.env</code>, old process exits). See <a href="/docs/networks">Networks</a>.</p>
<h2>Files on disk (the escape hatch)</h2>
<p>Everything the UI does maps to plain files you can also edit directly: <code>products.json</code> (hot-reloads on save), <code>content/&lt;sku&gt;/</code> folders, <code>.env</code>. The UI is a convenience, not a lock-in.</p>`,
  },
  {
    slug: "networks",
    title: "Networks",
    body: `
<p class="lede">One gateway, two modes. The flip is a setting, not a migration — products, sales history, and stats survive it.</p>
<table>
<thead><tr><th></th><th>Testnet (default)</th><th>Mainnet</th></tr></thead>
<tbody>
<tr><td>Network</td><td>Base Sepolia — <code>eip155:84532</code></td><td>Base — <code>eip155:8453</code></td></tr>
<tr><td>Money</td><td>test USDC (free from faucets)</td><td><strong>real USDC</strong></td></tr>
<tr><td>Facilitator</td><td>x402.org — free, no signup</td><td>Coinbase CDP — free tier 1,000 settlements/mo, then $0.001</td></tr>
<tr><td>Credentials</td><td>none</td><td><code>CDP_API_KEY_ID</code> / <code>CDP_API_KEY_SECRET</code></td></tr>
</tbody>
</table>
<h2>Flipping to mainnet</h2>
<ol>
<li>Create a CDP account + <strong>Secret API Key</strong> at <code>portal.cdp.coinbase.com</code> (leave all Coinbase App/Trade permission toggles OFF — the key only authenticates to the facilitator and can never move funds; Ed25519 signature is fine; no client API key needed)</li>
<li>In <a href="/admin/settings">Settings</a>: paste the keys, fill the <strong>mainnet receive address</strong> slot with a self-custody wallet you control, select Mainnet, save</li>
<li>Click <strong>Restart server now</strong> in the amber banner (or restart however you run it — automatic under systemd)</li>
</ol>
<p>The testnet receive address lives in its own slot and survives the flip — the two channels never mix.</p>
<h2>Refusals that protect you</h2>
<ul>
<li>Mainnet without CDP keys → refuses to start, names the missing variables</li>
<li>Mainnet with a generated dev wallet as <code>payTo</code> → refused; a throwaway testnet key must never receive real funds</li>
</ul>
<p>Treat your first mainnet sale as the go-live test: buy from yourself for $0.01 and check the settlement on basescan.org before publicizing the URL.</p>
<h2>Going public without a static IP</h2>
<p>Bind stays <code>127.0.0.1</code>; expose via a Cloudflare Tunnel ingress hostname (outbound-only — works behind CGNAT/dynamic IP, zero open ports). Keep <code>/admin</code> off the tunnel. Add a cache-bypass rule for paid paths — an edge-cached 402 breaks buying.</p>`,
  },
  {
    slug: "security",
    title: "Security model",
    body: `
<p class="lede">What the gateway defends by construction, and what remains yours to operate safely.</p>
<h2>Serving is confined</h2>
<p>Every directory-product read and delete goes through one guard (<code>resolveSafe</code>): realpath containment (catches <code>../</code> traversal <em>and</em> symlinks pointing out of the folder), a deny on any dot-segment (<code>.env</code>, <code>.git/…</code>), and a deny on secret extensions (<code>*.env</code>, <code>*.key</code>, <code>*.pem</code>). Uploads pass the same rules, with path components stripped from filenames. Structural separation is the primary wall: secrets live in the app root, content in its own subtree — the gateway never serves its own root.</p>
<h2>Money-path invariants</h2>
<ul>
<li><strong>404 before 402</strong> — a buyer can never pay for a missing file</li>
<li>Every settlement writes synchronously with a unique tx hash (no double-count); every paid request row links to it — the reconciliation invariant: <em>every 200 served = exactly one on-chain transfer</em></li>
<li>Demand-pricing floor/ceiling bound what any traffic manipulation can achieve</li>
<li><strong>No hot key on the server</strong> — the gateway holds only your receiving <em>address</em>; nothing on the box can spend funds</li>
</ul>
<h2>Privacy</h2>
<p>Raw client IPs are never stored — only a salted hash. Full payer addresses (pseudonymous but linkable) appear only behind admin auth; the public feed truncates them to <code>0x1234…abcd</code>.</p>
<h2>Config integrity</h2>
<p>All catalog and settings writes are validated-before-write, atomic (temp file + rename), and audited to the journal (<code>[admin-audit]</code> lines). A changed <code>payTo</code> you didn't make is an incident, not an edit — it redirects revenue silently.</p>
<h2>Your side of the contract</h2>
<ul>
<li>Strong <code>ADMIN_PASSWORD</code> (≥12 enforced); keep <code>/admin</code> off any public tunnel</li>
<li><code>.env</code> stays 0600 and out of git (scaffolded that way)</li>
<li>Mainnet <code>payTo</code> is a self-custody address whose keys never touch this machine</li>
</ul>`,
  },
  {
    slug: "api",
    title: "HTTP reference",
    body: `
<p class="lede">The complete HTTP surface. Free means no payment, no auth.</p>
<table>
<thead><tr><th>Route</th><th>Access</th><th>What</th></tr></thead>
<tbody>
<tr><td><code>GET /catalog</code></td><td>free</td><td>storefront, HTML</td></tr>
<tr><td><code>GET /catalog.json</code></td><td>free</td><td>machine-readable catalog (products, files, sizes, excerpts)</td></tr>
<tr><td><code>GET /feed</code></td><td>free</td><td>recent sales, payer truncated</td></tr>
<tr><td><code>GET /docs…</code></td><td>free</td><td>these pages</td></tr>
<tr><td><em>product routes</em></td><td><strong>paid</strong></td><td>from <code>products.json</code> — 402 challenge / 200 + content</td></tr>
<tr><td><code>GET /admin</code></td><td>Basic auth</td><td>dashboard: tiles, products, sales, requests</td></tr>
<tr><td><code>GET/POST /admin/products…</code></td><td>Basic auth</td><td>add / edit / remove products</td></tr>
<tr><td><code>GET/POST /admin/files/:sku…</code></td><td>Basic auth</td><td>list / upload / delete a folder product's files</td></tr>
<tr><td><code>GET/POST /admin/settings</code></td><td>Basic auth</td><td>network mode, wallet, CDP keys</td></tr>
<tr><td><code>GET /admin/export/sales.csv</code></td><td>Basic auth</td><td>settlements as CSV</td></tr>
</tbody>
</table>
<h2>The 402 exchange</h2>
<p>Challenge — status <code>402</code>, header <code>payment-required</code> (base64 JSON):</p>
${code(`{ "x402Version": 2, "resource": { "url": "…", "description": "…" },
  "accepts": [ { "scheme": "exact", "network": "eip155:84532", "amount": "10000",
                 "asset": "0x036C…CF7e", "payTo": "0x…", "maxTimeoutSeconds": 300 } ] }`)}
<p><code>amount</code> is atomic units (USDC has 6 decimals: <code>10000</code> = $0.01). Retry with the signed payment in <code>X-PAYMENT</code>. Success — status <code>200</code>, header <code>PAYMENT-RESPONSE</code> (base64 JSON):</p>
${code(`{ "success": true, "payer": "0x…", "transaction": "0x…", "network": "eip155:84532" }`)}
<p>Browsers (Accept: text/html + Mozilla UA) get a wallet-connect payment page on 402 instead of JSON.</p>
<h2>Environment</h2>
${code(`PAY_TO=0x…                 # receiving wallet (required)
NETWORK=eip155:84532       # default testnet; eip155:8453 = mainnet
FACILITATOR_URL=https://x402.org/facilitator   # testnet default
ADMIN_PASSWORD=…           # min 12 chars (required)
IP_SALT=…                  # for hashed request logging (required)
PORT=8402  DB_PATH=./sandbox.db
CDP_API_KEY_ID= CDP_API_KEY_SECRET=            # mainnet only`)}`,
  },
];

export function docsRoutes(): Hono {
  const app = new Hono();
  const render = (current: DocPage) => {
    const toc = PAGES.map((p) => {
      const href = p.slug ? `/docs/${p.slug}` : "/docs";
      const active = p.slug === current.slug;
      return `<a href="${href}" style="display:block;padding:.3rem .6rem;border-radius:8px;${active ? "background:var(--accent-soft);color:var(--accent);font-weight:650" : "color:var(--ink-2)"}">${p.title}</a>`;
    }).join("");
    const body = `
<div style="display:grid;grid-template-columns:180px 1fr;gap:2rem;align-items:start">
  <nav style="position:sticky;top:4.5rem;display:grid;gap:.15rem">${toc}</nav>
  <article style="min-width:0"><h1>${current.title === "Overview" ? "Documentation" : current.title}</h1>${current.body}</article>
</div>
<style>@media (max-width:700px){div[style*="grid-template-columns"]{grid-template-columns:1fr !important}nav[style*="sticky"]{position:static !important;display:flex !important;flex-wrap:wrap}}</style>`;
    return page(`Docs — ${current.title}`, body);
  };

  app.get("/docs", (c) => c.html(render(PAGES[0]!)));
  app.get("/docs/:slug", (c) => {
    const p = PAGES.find((p) => p.slug === c.req.param("slug"));
    return p ? c.html(render(p)) : c.text("Not Found", 404);
  });
  return app;
}
