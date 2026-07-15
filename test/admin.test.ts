import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Store } from '../src/db.js';
import { adminApp } from '../src/admin.js';

const PW = 'hunter2';
const NETWORK = 'base-sepolia';
const PAYER = '0x1111222233334444555566667777888899990000';
const TX = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const XSS = '<script>alert(1)</script>';

const auth = { Authorization: `Basic ${Buffer.from(`admin:${PW}`).toString('base64')}` };

let store: Store;
let app: Hono;

beforeAll(() => {
  store = new Store(':memory:');
  store.syncProducts([
    { sku: 'ebook-1', title: 'My Ebook', price: '1.50', network: NETWORK, contentPath: '/x/ebook.pdf' },
  ]);
  const now = new Date().toISOString();
  store.insertSettlement({ ts: now, productId: 1, amountUsdc: '1.50', payer: PAYER, txHash: TX, network: NETWORK });
  store.insertRequest({ ts: now, method: 'GET', path: '/buy/ebook-1', productId: 1, outcome: 'unpaid_402', statusCode: 402 });
  store.insertRequest({
    ts: now, method: 'GET', path: '/buy/ebook-1', productId: 1, outcome: 'paid_200',
    statusCode: 200, payer: PAYER, txHash: TX, userAgent: XSS, ipHash: 'deadbeef',
  });
  app = new Hono();
  app.route('/admin', adminApp(store, PW, NETWORK));
});

afterAll(() => store.close());

describe('adminApp', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.request('/admin');
    expect(res.status).toBe(401);
  });

  it('rejects wrong password with 401', async () => {
    const res = await app.request('/admin', {
      headers: { Authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` },
    });
    expect(res.status).toBe(401);
  });

  it('renders the stats page for authenticated requests', async () => {
    const res = await app.request('/admin', { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('ebook-1'); // product sku
    expect(html).toContain('1.50'); // total revenue figure
    expect(html).toContain(PAYER); // full payer address in recent sales
    expect(html).toContain(TX); // tx hash
    expect(html).toContain('/buy/ebook-1'); // recent request path
    // conversion: 1 paid, 1 unpaid
    expect(html).toMatch(/paid[^0-9]*1/i);
    expect(html).toMatch(/unpaid[^0-9]*1/i);
  });

  it('escapes wire-sourced strings (no XSS via user-agent)', async () => {
    const res = await app.request('/admin', { headers: auth });
    const html = await res.text();
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
