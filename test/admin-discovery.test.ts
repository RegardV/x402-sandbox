import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { adminDiscovery } from "../src/admin-discovery.js";
import type { ProductConfig } from "../src/config.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const products: ProductConfig[] = [
  { sku: "lib", title: "Library", price: "$0.01", route: "GET /lib/*", contentDir: "/x", discoverable: true },
  { sku: "quiet", title: "Quiet", price: "$0.02", route: "GET /q.md", contentPath: "./q.md" },
];

function mount(list: () => Promise<{ items: Array<{ resource: string; accepts: Array<{ payTo: string }>; lastUpdated: string }> }>) {
  return new Hono().route("/admin", adminDiscovery({ products: () => products, payTo: PAY_TO, publicOrigin: "https://x.example.com", list }));
}

describe("admin discovery check", () => {
  test("listed product shows as found with its registry timestamp", async () => {
    const app = mount(async () => ({
      items: [{ resource: "https://x.example.com/lib/guide.md", accepts: [{ payTo: PAY_TO }], lastUpdated: "2026-07-16T10:00:00Z" }],
    }));
    const html = await (await app.request("/admin/discovery")).text();
    expect(html).toContain("lib");
    expect(html).toMatch(/listed|found/i);
    expect(html).toContain("2026-07-16");
  });

  test("discoverable-but-unlisted product shows as not found; non-discoverable marked off", async () => {
    const app = mount(async () => ({ items: [] }));
    const html = await (await app.request("/admin/discovery")).text();
    expect(html).toMatch(/not (yet )?(listed|found)/i);
    expect(html).toMatch(/discovery off/i);
  });

  test("registry errors render as a message, not a crash", async () => {
    const app = mount(async () => {
      throw new Error("facilitator has no discovery API");
    });
    const res = await app.request("/admin/discovery");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("facilitator has no discovery API");
  });
});
