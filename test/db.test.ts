import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/db.js';

const P = (over: Record<string, unknown> = {}) => ({
  sku: 'ebook-1',
  title: 'Ebook One',
  price: '0.05',
  network: 'base-sepolia',
  ...over,
});

const REQ = (over: Record<string, unknown> = {}) => ({
  ts: new Date().toISOString(),
  method: 'GET',
  path: '/buy/ebook-1',
  outcome: 'unpaid_402' as const,
  ...over,
});

const SET = (over: Record<string, unknown> = {}) => ({
  ts: new Date().toISOString(),
  amountUsdc: '0.05',
  payer: '0xabc',
  txHash: `0x${Math.random().toString(16).slice(2)}`,
  network: 'base-sepolia',
  ...over,
});

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => {
  store.close();
});

describe('schema', () => {
  it('creates on :memory: without error', () => {
    expect(store.activeProducts()).toEqual([]);
  });
});

describe('syncProducts', () => {
  it('inserts new products', () => {
    store.syncProducts([P({ description: 'a book', contentPath: 'content/a.pdf', mimeType: 'application/pdf', discoverable: true })]);
    const p = store.productBySku('ebook-1');
    expect(p).toMatchObject({
      sku: 'ebook-1',
      title: 'Ebook One',
      description: 'a book',
      priceUsdc: '0.05',
      network: 'base-sepolia',
      contentPath: 'content/a.pdf',
      mimeType: 'application/pdf',
      discoverable: true,
      active: true,
    });
    expect(p!.id).toBeTypeOf('number');
  });

  it('updates existing product by sku', () => {
    store.syncProducts([P()]);
    const before = store.productBySku('ebook-1')!;
    store.syncProducts([P({ title: 'New Title', price: '0.10' })]);
    const after = store.productBySku('ebook-1')!;
    expect(after.id).toBe(before.id);
    expect(after.title).toBe('New Title');
    expect(after.priceUsdc).toBe('0.10');
  });

  it('deactivates products missing from the list and reactivates on return', () => {
    store.syncProducts([P(), P({ sku: 'ebook-2', title: 'Two' })]);
    store.syncProducts([P()]);
    expect(store.activeProducts().map((p) => p.sku)).toEqual(['ebook-1']);
    expect(store.productBySku('ebook-2')!.active).toBe(false);
    store.syncProducts([P(), P({ sku: 'ebook-2', title: 'Two' })]);
    expect(store.productBySku('ebook-2')!.active).toBe(true);
  });

  it('normalizes price: "$0.05" and 0.05 both become "0.05"', () => {
    store.syncProducts([P({ price: '$0.05' }), P({ sku: 'n', title: 'N', price: 0.05 })]);
    expect(store.productBySku('ebook-1')!.priceUsdc).toBe('0.05');
    expect(store.productBySku('n')!.priceUsdc).toBe('0.05');
  });
});

describe('productBySku', () => {
  it('returns undefined for missing sku', () => {
    expect(store.productBySku('nope')).toBeUndefined();
  });
});

describe('insertSettlement', () => {
  it('throws on duplicate txHash', () => {
    store.insertSettlement(SET({ txHash: '0xdup' }));
    expect(() => store.insertSettlement(SET({ txHash: '0xdup' }))).toThrow();
  });
});

describe('totals', () => {
  it('sums and counts settlements filtered by network', () => {
    store.insertSettlement(SET({ amountUsdc: '0.05' }));
    store.insertSettlement(SET({ amountUsdc: '0.10' }));
    store.insertSettlement(SET({ amountUsdc: '9.99', network: 'base' }));
    expect(store.totals('base-sepolia')).toEqual({ totalUsdc: 0.15, saleCount: 2 });
    expect(store.totals('base')).toEqual({ totalUsdc: 9.99, saleCount: 1 });
    expect(store.totals('none')).toEqual({ totalUsdc: 0, saleCount: 0 });
  });
});

describe('daily', () => {
  it('groups earnings and sales by day within window', () => {
    const today = new Date().toISOString();
    store.insertSettlement(SET({ ts: today, amountUsdc: '0.05' }));
    store.insertSettlement(SET({ ts: today, amountUsdc: '0.10' }));
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    store.insertSettlement(SET({ ts: old, amountUsdc: '1.00' }));
    const rows = store.daily();
    expect(rows).toEqual([{ day: today.slice(0, 10), earnings: 0.15, sales: 2 }]);
    const wide = store.daily(60);
    expect(wide).toHaveLength(2);
  });
});

describe('conversion', () => {
  it('computes paid/unpaid ratio over rows with product_id', () => {
    store.syncProducts([P()]);
    const pid = store.productBySku('ebook-1')!.id;
    store.insertRequest(REQ({ productId: pid, outcome: 'unpaid_402' }));
    store.insertRequest(REQ({ productId: pid, outcome: 'unpaid_402' }));
    store.insertRequest(REQ({ productId: pid, outcome: 'paid_200' }));
    store.insertRequest(REQ({ outcome: 'unpaid_402' })); // no product_id, ignored
    expect(store.conversion()).toEqual({ paid: 1, unpaid: 2, ratio: 0.5 });
  });

  it('ratio is null when unpaid is 0', () => {
    expect(store.conversion()).toEqual({ paid: 0, unpaid: 0, ratio: null });
  });
});

describe('topProducts', () => {
  it('orders by revenue and respects limit', () => {
    store.syncProducts([P(), P({ sku: 'ebook-2', title: 'Two' })]);
    const p1 = store.productBySku('ebook-1')!.id;
    const p2 = store.productBySku('ebook-2')!.id;
    store.insertSettlement(SET({ productId: p1, amountUsdc: '0.05' }));
    store.insertSettlement(SET({ productId: p2, amountUsdc: '1.00' }));
    store.insertSettlement(SET({ productId: p2, amountUsdc: '1.00' }));
    const top = store.topProducts();
    expect(top[0]).toEqual({ sku: 'ebook-2', title: 'Two', sales: 2, revenue: 2 });
    expect(top[1]).toEqual({ sku: 'ebook-1', title: 'Ebook One', sales: 1, revenue: 0.05 });
    expect(store.topProducts(1)).toHaveLength(1);
  });
});

describe('recentSales', () => {
  it('returns newest first with limit', () => {
    store.syncProducts([P()]);
    const pid = store.productBySku('ebook-1')!.id;
    store.insertSettlement(SET({ productId: pid, ts: '2026-07-01T00:00:00.000Z', payer: '0x1' }));
    store.insertSettlement(SET({ productId: pid, ts: '2026-07-02T00:00:00.000Z', payer: '0x2' }));
    store.insertSettlement(SET({ productId: pid, ts: '2026-07-03T00:00:00.000Z', payer: '0x3' }));
    const sales = store.recentSales(2);
    expect(sales).toHaveLength(2);
    expect(sales[0]).toMatchObject({ ts: '2026-07-03T00:00:00.000Z', sku: 'ebook-1', title: 'Ebook One', payer: '0x3' });
    expect(sales[1]!.payer).toBe('0x2');
  });
});

describe('recentRequests', () => {
  it('returns newest first with limit and full fields', () => {
    store.insertRequest(REQ({ ts: '2026-07-01T00:00:00.000Z', path: '/a', statusCode: 402, payer: '0x1', priceUsdc: '0.05', txHash: '0xt', userAgent: 'ua', ipHash: 'ih' }));
    store.insertRequest(REQ({ ts: '2026-07-02T00:00:00.000Z', path: '/b' }));
    store.insertRequest(REQ({ ts: '2026-07-03T00:00:00.000Z', path: '/c' }));
    const rows = store.recentRequests(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ts: '2026-07-03T00:00:00.000Z', path: '/c' });
    expect(rows[0]!.id).toBeTypeOf('number');
    const all = store.recentRequests();
    const first = all.find((r) => r.path === '/a')!;
    expect(first).toMatchObject({
      method: 'GET',
      outcome: 'unpaid_402',
      statusCode: 402,
      payer: '0x1',
      priceUsdc: '0.05',
      txHash: '0xt',
      userAgent: 'ua',
      ipHash: 'ih',
    });
  });
});
