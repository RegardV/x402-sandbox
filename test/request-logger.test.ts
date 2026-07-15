import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db.js';
import { hashIp, parsePaymentResponse, requestLogger } from '../src/request-logger.js';

const SALT = 'pepper';
const flush = () => new Promise((r) => setImmediate(r));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const receipt = { payer: '0xPayer', transaction: '0xTx1', network: 'base' };
const b64Receipt = Buffer.from(JSON.stringify(receipt)).toString('base64');

function makeApp() {
  const store = new Store(':memory:');
  store.syncProducts([{ sku: 'demo', title: 'Demo', price: '1.50', network: 'base' }]);
  const product = store.activeProducts()[0]!;
  const app = new Hono();
  app.use(
    '*',
    requestLogger({
      store,
      ipSalt: SALT,
      matchProduct: (_method, path) =>
        path.startsWith('/paid') ? { id: product.id, priceUsdc: product.priceUsdc } : undefined,
    }),
  );
  app.get('/free', (c) => c.text('hello'));
  app.get('/paid/402', (c) => c.text('payment required', 402));
  app.get('/paid/ok', (c) => {
    const hdr = c.req.header('x-test-payment');
    if (hdr) c.header('PAYMENT-RESPONSE', hdr);
    return c.text('content');
  });
  app.get('/paid/ok-x', (c) => {
    const hdr = c.req.header('x-test-payment');
    if (hdr) c.header('X-PAYMENT-RESPONSE', hdr);
    return c.text('content');
  });
  app.get('/boom', () => {
    // Non-Error throw: Hono's compose handles Error instances via onError at the
    // throwing handler's own level, so only non-Error values propagate through
    // outer middleware — the only way to exercise the logger's catch/rethrow path.
    throw 'kaboom';
  });
  return { app, store };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestLogger middleware', () => {
  it('logs free_200 for unmatched route with 200', async () => {
    const { app, store } = makeApp();
    const res = await app.request('/free', { headers: { 'user-agent': 'test-ua' } });
    expect(res.status).toBe(200);
    await flush();
    const rows = store.recentRequests();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.outcome).toBe('free_200');
    expect(row.method).toBe('GET');
    expect(row.path).toBe('/free');
    expect(row.statusCode).toBe(200);
    expect(row.productId).toBeUndefined();
    expect(row.userAgent).toBe('test-ua');
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('logs not_found for unmatched route with 404', async () => {
    const { app, store } = makeApp();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    await flush();
    expect(store.recentRequests()[0]!.outcome).toBe('not_found');
  });

  it('logs unpaid_402 with product id and price', async () => {
    const { app, store } = makeApp();
    const res = await app.request('/paid/402');
    expect(res.status).toBe(402);
    await flush();
    const row = store.recentRequests()[0]!;
    expect(row.outcome).toBe('unpaid_402');
    expect(row.productId).toBe(1);
    expect(row.priceUsdc).toBe('1.50');
  });

  it('paid_200 with base64 header writes settlement and stamps request row', async () => {
    const { app, store } = makeApp();
    const res = await app.request('/paid/ok', { headers: { 'x-test-payment': b64Receipt } });
    expect(res.status).toBe(200);
    expect(store.totals('base').saleCount).toBe(1);
    await flush();
    const row = store.recentRequests()[0]!;
    expect(row.outcome).toBe('paid_200');
    expect(row.payer).toBe('0xPayer');
    expect(row.txHash).toBe('0xTx1');
  });

  it('paid_200 with plain JSON header (X-PAYMENT-RESPONSE) writes settlement', async () => {
    const { app, store } = makeApp();
    const res = await app.request('/paid/ok-x', {
      headers: { 'x-test-payment': JSON.stringify({ payer: '0xP2', txHash: '0xTx2', networkId: 'base' }) },
    });
    expect(res.status).toBe(200);
    expect(store.totals('base').saleCount).toBe(1);
    await flush();
    const row = store.recentRequests()[0]!;
    expect(row.payer).toBe('0xP2');
    expect(row.txHash).toBe('0xTx2');
  });

  it('paid_200 with unparseable header logs paid_200 without settlement', async () => {
    const { app, store } = makeApp();
    const res = await app.request('/paid/ok', { headers: { 'x-test-payment': '%%%not-json%%%' } });
    expect(res.status).toBe(200);
    expect(store.totals('base').saleCount).toBe(0);
    await flush();
    const row = store.recentRequests()[0]!;
    expect(row.outcome).toBe('paid_200');
    expect(row.payer).toBeUndefined();
    expect(row.txHash).toBeUndefined();
  });

  it('duplicate txHash warns but response stays 200', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, store } = makeApp();
    await app.request('/paid/ok', { headers: { 'x-test-payment': b64Receipt } });
    const res = await app.request('/paid/ok', { headers: { 'x-test-payment': b64Receipt } });
    expect(res.status).toBe(200);
    expect(store.totals('base').saleCount).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('downstream throw logs error row with 500 and rethrows', async () => {
    const { app, store } = makeApp();
    await expect(app.request('/boom')).rejects.toBe('kaboom');
    await flush();
    const row = store.recentRequests()[0]!;
    expect(row.outcome).toBe('error');
    expect(row.statusCode).toBe(500);
  });

  it('hashes x-forwarded-for first entry, never storing the raw ip', async () => {
    const { app, store } = makeApp();
    await app.request('/free', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    await flush();
    const row = store.recentRequests()[0]!;
    expect(row.ipHash).toBe(sha256('203.0.113.9' + SALT));
    expect(row.ipHash).not.toContain('203.0.113.9');
  });

  it('hashes "unknown" when no x-forwarded-for header', async () => {
    const { app, store } = makeApp();
    await app.request('/free');
    await flush();
    expect(store.recentRequests()[0]!.ipHash).toBe(sha256('unknown' + SALT));
  });
});

describe('parsePaymentResponse', () => {
  it('parses base64-encoded JSON', () => {
    expect(parsePaymentResponse(b64Receipt)).toEqual({
      payer: '0xPayer',
      txHash: '0xTx1',
      network: 'base',
      raw: b64Receipt,
    });
  });

  it('parses plain JSON', () => {
    const raw = JSON.stringify(receipt);
    expect(parsePaymentResponse(raw)).toEqual({
      payer: '0xPayer',
      txHash: '0xTx1',
      network: 'base',
      raw,
    });
  });

  it('accepts alternate field spellings txHash / tx_hash / networkId', () => {
    const a = JSON.stringify({ txHash: '0xA', networkId: 'base-sepolia' });
    expect(parsePaymentResponse(a)).toMatchObject({ txHash: '0xA', network: 'base-sepolia' });
    const b = JSON.stringify({ tx_hash: '0xB' });
    expect(parsePaymentResponse(b)).toMatchObject({ txHash: '0xB' });
    expect(parsePaymentResponse(b)!.payer).toBeUndefined();
  });

  it('returns null for unparseable input', () => {
    expect(parsePaymentResponse('%%%not-json%%%')).toBeNull();
    expect(parsePaymentResponse('')).toBeNull();
    expect(parsePaymentResponse('42')).toBeNull();
  });
});

describe('hashIp', () => {
  it('is deterministic sha256 hex of ip + salt', () => {
    expect(hashIp('1.2.3.4', 'salt')).toBe(sha256('1.2.3.4salt'));
    expect(hashIp('1.2.3.4', 'salt')).toBe(hashIp('1.2.3.4', 'salt'));
    expect(hashIp('1.2.3.4', 'other')).not.toBe(hashIp('1.2.3.4', 'salt'));
    expect(hashIp('1.2.3.4', 'salt')).toMatch(/^[0-9a-f]{64}$/);
  });
});
