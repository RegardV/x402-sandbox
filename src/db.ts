import { DatabaseSync } from 'node:sqlite';

export interface ProductRow {
  id: number;
  sku: string;
  title: string;
  description: string | null;
  priceUsdc: string;
  network: string;
  contentPath: string | null;
  bundlePath: string | null;
  contentDir: string | null;
  mimeType: string | null;
  discoverable: boolean;
  active: boolean;
}

export interface RequestLog {
  ts: string;
  method: string;
  path: string;
  productId?: number;
  outcome: 'unpaid_402' | 'paid_200' | 'error' | 'free_200' | 'not_found';
  statusCode?: number;
  payer?: string;
  priceUsdc?: string;
  txHash?: string;
  userAgent?: string;
  ipHash?: string;
}

export interface Settlement {
  ts: string;
  productId?: number;
  amountUsdc: string;
  payer: string;
  txHash: string;
  network: string;
  facilitator?: string;
}

export interface ProductInput {
  sku: string;
  title: string;
  description?: string;
  price: string | number;
  network: string;
  contentPath?: string;
  bundlePath?: string;
  contentDir?: string;
  mimeType?: string;
  discoverable?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price_usdc TEXT NOT NULL,
  network TEXT NOT NULL,
  content_path TEXT,
  bundle_path TEXT,
  content_dir TEXT,
  mime_type TEXT,
  discoverable INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('unpaid_402','paid_200','error','free_200','not_found')),
  status_code INTEGER,
  payer TEXT,
  price_usdc TEXT,
  tx_hash TEXT,
  user_agent TEXT,
  ip_hash TEXT
);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  amount_usdc TEXT NOT NULL,
  payer TEXT NOT NULL,
  tx_hash TEXT UNIQUE NOT NULL,
  network TEXT NOT NULL,
  facilitator TEXT,
  zar_value TEXT
);
`;

const MICRO = 'CAST(ROUND(CAST(amount_usdc AS REAL) * 1e6) AS INTEGER)';

function normalizePrice(price: string | number): string {
  return String(price).replace(/^\$/, '').trim();
}

function toProductRow(r: Record<string, unknown>): ProductRow {
  return {
    id: r.id as number,
    sku: r.sku as string,
    title: r.title as string,
    description: r.description as string | null,
    priceUsdc: r.price_usdc as string,
    network: r.network as string,
    contentPath: r.content_path as string | null,
    bundlePath: r.bundle_path as string | null,
    contentDir: r.content_dir as string | null,
    mimeType: r.mime_type as string | null,
    discoverable: r.discoverable === 1,
    active: r.active === 1,
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  syncProducts(products: ProductInput[]): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO products (sku, title, description, price_usdc, network, content_path, bundle_path, content_dir, mime_type, discoverable, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET
        title = excluded.title, description = excluded.description, price_usdc = excluded.price_usdc,
        network = excluded.network, content_path = excluded.content_path, bundle_path = excluded.bundle_path,
        content_dir = excluded.content_dir, mime_type = excluded.mime_type, discoverable = excluded.discoverable,
        active = 1, updated_at = excluded.updated_at
    `);
    for (const p of products) {
      upsert.run(
        p.sku, p.title, p.description ?? null, normalizePrice(p.price), p.network,
        p.contentPath ?? null, p.bundlePath ?? null, p.contentDir ?? null, p.mimeType ?? null,
        p.discoverable ? 1 : 0, now, now,
      );
    }
    const skus = products.map((p) => p.sku);
    const placeholders = skus.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE products SET active = 0, updated_at = ? WHERE active = 1${skus.length ? ` AND sku NOT IN (${placeholders})` : ''}`,
    ).run(now, ...skus);
  }

  activeProducts(): ProductRow[] {
    return (this.db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all() as Record<string, unknown>[]).map(toProductRow);
  }

  productBySku(sku: string): ProductRow | undefined {
    const row = this.db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as Record<string, unknown> | undefined;
    return row ? toProductRow(row) : undefined;
  }

  /** Paid-but-not-delivered protection: a recent settled purchase of this exact
   *  path from the same (hashed) source grants free redelivery within the window. */
  findRedeliveryGrant(
    path: string,
    ipHash: string,
    windowMinutes: number,
  ): { txHash: string; payer: string | null } | undefined {
    const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    const row = this.db
      .prepare(
        "SELECT tx_hash, payer FROM requests WHERE path = ? AND ip_hash = ? AND outcome = 'paid_200' AND ts >= ? ORDER BY id DESC LIMIT 1",
      )
      .get(path, ipHash, cutoff) as { tx_hash: string; payer: string | null } | undefined;
    return row ? { txHash: row.tx_hash, payer: row.payer } : undefined;
  }

  /** Paid hits per request path — the per-file sales signal for folder products. */
  paidCountsByPath(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT path, COUNT(*) AS c FROM requests WHERE outcome = 'paid_200' GROUP BY path")
      .all() as Array<{ path: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.path, r.c]));
  }

  /** PII-minimizing retention: purge traffic rows older than N days. The
   *  settlements table is the permanent financial ledger and is never trimmed. */
  trimRequests(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const res = this.db.prepare("DELETE FROM requests WHERE ts < ?").run(cutoff);
    return Number(res.changes);
  }

  /** Persist a demand-repriced price (decimal string, no "$"). */
  setPrice(sku: string, priceUsdc: string): void {
    this.db
      .prepare("UPDATE products SET price_usdc = ?, updated_at = ? WHERE sku = ?")
      .run(priceUsdc, new Date().toISOString(), sku);
  }

  /** Settled sales for a product since an ISO timestamp (the demand signal). */
  salesCountSince(productId: number, sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM settlements WHERE product_id = ? AND ts >= ?")
      .get(productId, sinceIso) as { c: number };
    return row.c;
  }

  insertRequest(r: RequestLog): void {
    this.db.prepare(`
      INSERT INTO requests (ts, method, path, product_id, outcome, status_code, payer, price_usdc, tx_hash, user_agent, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.ts, r.method, r.path, r.productId ?? null, r.outcome, r.statusCode ?? null,
      r.payer ?? null, r.priceUsdc ?? null, r.txHash ?? null, r.userAgent ?? null, r.ipHash ?? null,
    );
  }

  insertSettlement(s: Settlement): void {
    this.db.prepare(`
      INSERT INTO settlements (ts, product_id, amount_usdc, payer, tx_hash, network, facilitator)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(s.ts, s.productId ?? null, s.amountUsdc, s.payer, s.txHash, s.network, s.facilitator ?? null);
  }

  // ponytail: sums in integer micro-USDC (6 decimals) to avoid float drift; move to a decimal lib if sub-micro precision ever needed
  totals(network: string): { totalUsdc: number; saleCount: number } {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(${MICRO}), 0) AS total, COUNT(*) AS n FROM settlements WHERE network = ?`,
    ).get(network) as { total: number; n: number };
    return { totalUsdc: row.total / 1e6, saleCount: row.n };
  }

  daily(days = 7): Array<{ day: string; earnings: number; sales: number }> {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    return this.db.prepare(`
      SELECT substr(ts, 1, 10) AS day, SUM(${MICRO}) / 1e6 AS earnings, COUNT(*) AS sales
      FROM settlements WHERE ts >= ? GROUP BY day ORDER BY day
    `).all(cutoff) as Array<{ day: string; earnings: number; sales: number }>;
  }

  conversion(): { paid: number; unpaid: number; ratio: number | null } {
    const row = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN outcome = 'paid_200' THEN 1 END) AS paid,
        COUNT(CASE WHEN outcome = 'unpaid_402' THEN 1 END) AS unpaid
      FROM requests WHERE product_id IS NOT NULL
    `).get() as { paid: number; unpaid: number };
    return { paid: row.paid, unpaid: row.unpaid, ratio: row.unpaid === 0 ? null : row.paid / row.unpaid };
  }

  topProducts(limit = 5): Array<{ sku: string; title: string; sales: number; revenue: number }> {
    return this.db.prepare(`
      SELECT p.sku AS sku, p.title AS title, COUNT(*) AS sales, SUM(${MICRO}) / 1e6 AS revenue
      FROM settlements s JOIN products p ON p.id = s.product_id
      GROUP BY s.product_id ORDER BY revenue DESC LIMIT ?
    `).all(limit) as Array<{ sku: string; title: string; sales: number; revenue: number }>;
  }

  recentSales(limit = 10): Array<{ ts: string; sku: string; title: string; amountUsdc: string; payer: string }> {
    return this.db.prepare(`
      SELECT s.ts AS ts, p.sku AS sku, p.title AS title, s.amount_usdc AS amountUsdc, s.payer AS payer
      FROM settlements s JOIN products p ON p.id = s.product_id
      ORDER BY s.id DESC LIMIT ?
    `).all(limit) as Array<{ ts: string; sku: string; title: string; amountUsdc: string; payer: string }>;
  }

  recentRequests(limit = 50): Array<RequestLog & { id: number }> {
    const rows = this.db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as string,
      method: r.method as string,
      path: r.path as string,
      productId: (r.product_id as number | null) ?? undefined,
      outcome: r.outcome as RequestLog['outcome'],
      statusCode: (r.status_code as number | null) ?? undefined,
      payer: (r.payer as string | null) ?? undefined,
      priceUsdc: (r.price_usdc as string | null) ?? undefined,
      txHash: (r.tx_hash as string | null) ?? undefined,
      userAgent: (r.user_agent as string | null) ?? undefined,
      ipHash: (r.ip_hash as string | null) ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}
