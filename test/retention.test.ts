import { describe, expect, test } from "vitest";
import { Store } from "../src/db.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe("request-log retention", () => {
  test("trimRequests removes old traffic rows, keeps recent ones, never touches settlements", () => {
    const s = new Store(":memory:");
    s.syncProducts([{ sku: "p", title: "P", price: "$0.01", network: "eip155:84532", contentDir: "." }]);
    const pid = s.productBySku("p")!.id;

    s.insertRequest({ ts: daysAgo(120), method: "GET", path: "/old", outcome: "unpaid_402", productId: pid });
    s.insertRequest({ ts: daysAgo(120), method: "GET", path: "/old-paid", outcome: "paid_200", productId: pid, txHash: "0x1" });
    s.insertRequest({ ts: daysAgo(1), method: "GET", path: "/fresh", outcome: "unpaid_402", productId: pid });
    s.insertSettlement({ ts: daysAgo(120), productId: pid, amountUsdc: "0.01", payer: "0xabc", txHash: "0x1", network: "eip155:84532" });

    const removed = s.trimRequests(90);
    expect(removed).toBe(2); // both old rows go — settlements is the permanent ledger
    const paths = s.recentRequests(10).map((r) => r.path);
    expect(paths).toEqual(["/fresh"]);
    expect(s.recentSales(10)).toHaveLength(1); // financial ledger untouched
  });

  test("trim with nothing old is a no-op", () => {
    const s = new Store(":memory:");
    s.insertRequest({ ts: daysAgo(5), method: "GET", path: "/x", outcome: "free_200" });
    expect(s.trimRequests(90)).toBe(0);
    expect(s.recentRequests(10)).toHaveLength(1);
  });
});
