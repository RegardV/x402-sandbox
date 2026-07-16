import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { adminApp } from "../src/admin.js";
import { Store } from "../src/db.js";

const GOOD = "Basic " + Buffer.from("admin:correct-password-123").toString("base64");
const BAD = "Basic " + Buffer.from("admin:wrong-guess").toString("base64");

function fixture() {
  const app = new Hono();
  app.route("/admin", adminApp(new Store(":memory:"), "correct-password-123", "eip155:84532"));
  const hit = (auth: string, ip = "203.0.113.7") =>
    app.request("/admin", { headers: { authorization: auth, "x-forwarded-for": ip } });
  return { hit };
}

describe("admin login lockout", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => (f = fixture()));

  test("five failures lock the source out — even the correct password then gets 429", async () => {
    for (let i = 0; i < 5; i++) expect((await f.hit(BAD)).status).toBe(401);
    expect((await f.hit(BAD)).status).toBe(429);
    expect((await f.hit(GOOD)).status).toBe(429); // locked means locked
  });

  test("lockout is per source ip — another ip still logs in", async () => {
    for (let i = 0; i < 6; i++) await f.hit(BAD, "203.0.113.7");
    expect((await f.hit(GOOD, "198.51.100.9")).status).toBe(200);
  });

  test("a successful login resets the failure count", async () => {
    for (let i = 0; i < 4; i++) await f.hit(BAD);
    expect((await f.hit(GOOD)).status).toBe(200);
    for (let i = 0; i < 4; i++) await f.hit(BAD);
    expect((await f.hit(GOOD)).status).toBe(200); // would be locked without the reset
  });
});
