import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { Store } from '../src/db.js';
import { adminCrud } from '../src/admin-crud.js';

const PW = 'hunter2';

function readCatalog(productsPath: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(productsPath, 'utf8')).products;
}

function form(fields: Record<string, string>): { body: URLSearchParams; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(fields),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  };
}

let baseDir: string;
let productsPath: string;
let store: Store;
let onCatalogChange: ReturnType<typeof vi.fn>;
let app: Hono;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'admin-crud-'));
  writeFileSync(join(baseDir, 'article.md'), '# hi');
  productsPath = join(baseDir, 'products.json');
  writeFileSync(
    productsPath,
    JSON.stringify({
      products: [
        {
          sku: 'ebook-1',
          title: 'My Ebook',
          price: '$1.50',
          route: 'GET /files/ebook',
          contentPath: './article.md',
        },
      ],
    }),
  );
  store = new Store(':memory:');
  onCatalogChange = vi.fn();
  app = new Hono();
  app.route('/admin', adminCrud({ store, productsPath, baseDir, onCatalogChange }));
});

afterEach(() => store.close());

describe('adminCrud auth', () => {
  it('POST routes 401 without credentials when mounted under basicAuth', async () => {
    const gated = new Hono();
    gated.use('*', basicAuth({ username: 'admin', password: PW }));
    gated.route('/admin', adminCrud({ store, productsPath, baseDir }));
    const res = await gated.request('/admin/products', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('create', () => {
  it('appends a valid product, writes file, calls onCatalogChange, redirects', async () => {
    const { body, headers } = form({
      sku: 'new-sku',
      title: 'New Thing',
      price: '$0.05',
      route: 'GET /files/new',
      contentPath: './article.md',
    });
    const res = await app.request('/admin/products', { method: 'POST', body, headers });
    expect(res.status).toBe(302);
    expect(onCatalogChange).toHaveBeenCalledTimes(1);
    const catalog = readCatalog(productsPath);
    expect(catalog.some((p) => p.sku === 'new-sku' && p.title === 'New Thing')).toBe(true);
    expect(existsSync(`${productsPath}.tmp`)).toBe(false);
  });

  it('rejects a product missing contentPath/bundlePath/contentDir with 400 and leaves file unchanged', async () => {
    const before = readFileSync(productsPath, 'utf8');
    const { body, headers } = form({
      sku: 'bad-sku',
      title: 'Bad Thing',
      price: '$0.05',
      route: 'GET /files/bad',
    });
    const res = await app.request('/admin/products', { method: 'POST', body, headers });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/contentPath|bundlePath|contentDir/);
    expect(readFileSync(productsPath, 'utf8')).toBe(before);
    expect(existsSync(`${productsPath}.tmp`)).toBe(false);
  });
});

describe('edit', () => {
  it('updates price and writes file', async () => {
    const { body, headers } = form({
      title: 'My Ebook',
      price: '$2.00',
      route: 'GET /files/ebook',
      contentPath: './article.md',
    });
    const res = await app.request('/admin/products/ebook-1', { method: 'POST', body, headers });
    expect(res.status).toBe(302);
    const catalog = readCatalog(productsPath);
    const entry = catalog.find((p) => p.sku === 'ebook-1');
    expect(entry?.price).toBe('$2.00');
    expect(existsSync(`${productsPath}.tmp`)).toBe(false);
  });

  it('renders escaped HTML for a product with unsafe title', async () => {
    writeFileSync(
      productsPath,
      JSON.stringify({
        products: [
          {
            sku: 'xss-sku',
            title: '<b>x</b>',
            price: '$1.00',
            route: 'GET /files/xss',
            contentPath: './article.md',
          },
        ],
      }),
    );
    const res = await app.request('/admin/products/xss-sku/edit');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('delete', () => {
  it('removes the entry and writes file', async () => {
    const res = await app.request('/admin/products/ebook-1/delete', { method: 'POST' });
    expect(res.status).toBe(302);
    const catalog = readCatalog(productsPath);
    expect(catalog.some((p) => p.sku === 'ebook-1')).toBe(false);
    expect(existsSync(`${productsPath}.tmp`)).toBe(false);
  });
});

describe('export CSV', () => {
  it('emits header, a settlement row, and escapes commas in titles', async () => {
    store.syncProducts([
      { sku: 'ebook-1', title: 'Comma, Title', price: '1.50', network: 'base-sepolia', contentPath: '/x/a.pdf' },
    ]);
    const now = new Date().toISOString();
    store.insertSettlement({
      ts: now, productId: 1, amountUsdc: '1.50', payer: '0xabc', txHash: '0xdeadbeef', network: 'base-sepolia',
    });
    const res = await app.request('/admin/export/sales.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('ts,sku,title,amount_usdc,payer');
    expect(csv).toContain('"Comma, Title"');
    expect(csv).toContain('0xabc');
  });
});
