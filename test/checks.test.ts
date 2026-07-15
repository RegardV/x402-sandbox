import { describe, it, expect } from "vitest";
import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPrereqs, nextSteps } from "../src/cli/checks.js";

describe("checkPrereqs", () => {
  it("passes with node >= 20", () => {
    const report = checkPrereqs(tmpdir(), {
      nodeVersion: "v24.15.0",
      which: () => true,
    });
    expect(report.ok).toBe(true);
    const nodeCheck = report.checks.find((c) => c.name === "node");
    expect(nodeCheck?.ok).toBe(true);
    expect(nodeCheck?.required).toBe(true);
  });

  it("fails with node < 20", () => {
    const report = checkPrereqs(tmpdir(), {
      nodeVersion: "v18.9.9",
      which: () => true,
    });
    expect(report.ok).toBe(false);
    const nodeCheck = report.checks.find((c) => c.name === "node");
    expect(nodeCheck?.ok).toBe(false);
    expect(nodeCheck?.required).toBe(true);
  });

  it("fails when npm is missing", () => {
    const report = checkPrereqs(tmpdir(), {
      nodeVersion: "v24.15.0",
      which: (bin: string) => bin !== "npm",
    });
    expect(report.ok).toBe(false);
    const npmCheck = report.checks.find((c) => c.name === "npm");
    expect(npmCheck?.ok).toBe(false);
    expect(npmCheck?.required).toBe(true);
  });

  it("stays ok when cloudflared is missing (optional)", () => {
    const report = checkPrereqs(tmpdir(), {
      nodeVersion: "v24.15.0",
      which: (bin: string) => bin !== "cloudflared",
    });
    expect(report.ok).toBe(true);
    const cloudflaredCheck = report.checks.find(
      (c) => c.name === "cloudflared"
    );
    expect(cloudflaredCheck?.ok).toBe(false);
    expect(cloudflaredCheck?.required).toBe(false);
  });

  it("stays ok when git is missing (optional)", () => {
    const report = checkPrereqs(tmpdir(), {
      nodeVersion: "v24.15.0",
      which: (bin: string) => bin !== "git",
    });
    expect(report.ok).toBe(true);
    const gitCheck = report.checks.find((c) => c.name === "git");
    expect(gitCheck?.ok).toBe(false);
    expect(gitCheck?.required).toBe(false);
  });

  it("fails when targetDir is not writable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "x402-test-"));
    chmodSync(tempDir, 0o444); // read-only
    try {
      const report = checkPrereqs(tempDir, {
        nodeVersion: "v24.15.0",
        which: () => true,
      });
      expect(report.ok).toBe(false);
      const writableCheck = report.checks.find(
        (c) => c.name === "targetDir writable"
      );
      expect(writableCheck?.ok).toBe(false);
      expect(writableCheck?.required).toBe(true);
    } finally {
      chmodSync(tempDir, 0o755);
    }
  });

  it("includes all required checks", () => {
    const report = checkPrereqs(tmpdir(), {
      nodeVersion: "v24.15.0",
      which: () => true,
    });
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("npm");
    expect(names).toContain("cloudflared");
    expect(names).toContain("git");
    expect(names).toContain("targetDir writable");
  });

  it("uses default probes when none provided", () => {
    const report = checkPrereqs(tmpdir());
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
  });
});

describe("nextSteps", () => {
  it("includes faucet URL for testnet (eip155:84532)", () => {
    const output = nextSteps({
      port: 8402,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
      devWallet: "0xabcdef1234567890abcdef1234567890abcdef12",
    });
    expect(output).toContain("https://faucet.circle.com");
    expect(output).toContain("Base Sepolia");
  });

  it("includes devWallet address in faucet step when provided", () => {
    const devWallet = "0xabcdef1234567890abcdef1234567890abcdef12";
    const output = nextSteps({
      port: 8402,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
      devWallet,
    });
    expect(output).toContain(devWallet);
  });

  it("uses payTo address in faucet step when devWallet not provided", () => {
    const payTo = "0x1234567890abcdef1234567890abcdef12345678";
    const output = nextSteps({
      port: 8402,
      network: "eip155:84532",
      payTo,
    });
    expect(output).toContain(payTo);
  });

  it("includes npm start step", () => {
    const output = nextSteps({
      port: 8402,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(output).toContain("npm start");
  });

  it("includes all three URLs (catalog, feed, admin)", () => {
    const port = 8402;
    const output = nextSteps({
      port,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(output).toContain(`http://127.0.0.1:${port}/catalog`);
    expect(output).toContain(`http://127.0.0.1:${port}/feed`);
    expect(output).toContain(`http://127.0.0.1:${port}/admin`);
  });

  it("includes buyer test command with BUYER_PRIVATE_KEY", () => {
    const port = 8402;
    const output = nextSteps({
      port,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(output).toContain("BUYER_PRIVATE_KEY=");
    expect(output).toContain("node scripts/buy.mjs");
    expect(output).toContain(`http://127.0.0.1:${port}`);
  });

  it("includes cloudflared YAML snippet when tunnelHostname provided", () => {
    const tunnelHostname = "my-tunnel.example.com";
    const port = 8402;
    const output = nextSteps({
      port,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
      tunnelHostname,
    });
    expect(output).toContain("hostname:");
    expect(output).toContain(tunnelHostname);
    expect(output).toContain("service:");
    expect(output).toContain(`http://127.0.0.1:${port}`);
  });

  it("omits faucet step for mainnet (eip155:8453)", () => {
    const output = nextSteps({
      port: 8402,
      network: "eip155:8453",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(output).not.toContain("faucet");
    expect(output).not.toContain("Base Sepolia");
  });

  it("includes mainnet warning for eip155:8453", () => {
    const output = nextSteps({
      port: 8402,
      network: "eip155:8453",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(output).toContain("MAINNET");
    expect(output).toContain("real funds");
  });

  it("uses numbered list format", () => {
    const output = nextSteps({
      port: 8402,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(output).toMatch(/^\d+\./m);
  });

  it("omits tunnel section when tunnelHostname not provided", () => {
    const output = nextSteps({
      port: 8402,
      network: "eip155:84532",
      payTo: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(output).not.toContain("hostname:");
  });
});
