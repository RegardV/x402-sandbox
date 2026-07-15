import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { RequestLog, Store } from './db.js';

export interface LoggerDeps {
  store: Store;
  ipSalt: string;
  /** Resolves the paid product matched by this request, if any. Injected by the server. */
  matchProduct(method: string, path: string): { id: number; priceUsdc: string } | undefined;
}

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(ip + salt).digest('hex');
}

function tryJson(s: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function parsePaymentResponse(
  value: string,
): { payer?: string; txHash?: string; network?: string; raw: string } | null {
  const obj = tryJson(value) ?? tryJson(Buffer.from(value, 'base64').toString('utf8'));
  if (!obj) return null;
  return {
    payer: str(obj.payer),
    txHash: str(obj.transaction) ?? str(obj.txHash) ?? str(obj.tx_hash),
    network: str(obj.networkId) ?? str(obj.network),
    raw: value,
  };
}

function writeRow(store: Store, row: RequestLog): void {
  // Async and best-effort: logging must never fail or delay the buyer's response.
  queueMicrotask(() => {
    try {
      store.insertRequest(row);
    } catch (err) {
      console.warn('request-logger: failed to write request row', err);
    }
  });
}

export function requestLogger(deps: LoggerDeps): MiddlewareHandler {
  return async (c, next) => {
    const product = deps.matchProduct(c.req.method, c.req.path);
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const base: Omit<RequestLog, 'outcome'> = {
      ts: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      productId: product?.id,
      priceUsdc: product?.priceUsdc,
      userAgent: c.req.header('user-agent'),
      ipHash: hashIp(ip, deps.ipSalt),
    };

    try {
      await next();
    } catch (err) {
      writeRow(deps.store, { ...base, outcome: 'error', statusCode: 500 });
      throw err;
    }

    const status = c.res.status;
    const outcome: RequestLog['outcome'] = !product
      ? status === 404 ? 'not_found' : 'free_200'
      : status === 402 ? 'unpaid_402'
      : status >= 200 && status < 300 ? 'paid_200'
      : status === 404 ? 'not_found'
      : 'error';

    const row: RequestLog = { ...base, outcome, statusCode: status };

    if (outcome === 'paid_200') {
      const header =
        c.res.headers.get('PAYMENT-RESPONSE') ?? c.res.headers.get('X-PAYMENT-RESPONSE');
      const parsed = header ? parsePaymentResponse(header) : null;
      if (parsed?.txHash) {
        row.payer = parsed.payer;
        row.txHash = parsed.txHash;
        try {
          // Synchronous: financial writes must persist before the response completes.
          deps.store.insertSettlement({
            ts: row.ts,
            productId: product!.id,
            amountUsdc: product!.priceUsdc,
            payer: parsed.payer ?? 'unknown',
            txHash: parsed.txHash,
            network: parsed.network ?? 'unknown',
          });
        } catch (err) {
          console.warn('request-logger: settlement insert failed (duplicate txHash?)', err);
        }
      }
    }

    writeRow(deps.store, row);
  };
}
