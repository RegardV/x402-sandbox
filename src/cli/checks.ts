import { accessSync, constants } from "node:fs";

export interface PrereqReport {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    required: boolean;
  }>;
}

export interface Probes {
  nodeVersion?: string;
  which?: (bin: string) => boolean;
}

function parseNodeVersion(version: string): number {
  const match = version.match(/^v(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

function defaultWhichSync(bin: string): boolean {
  const path = process.env.PATH || "";
  const dirs = path.split(":");
  
  for (const dir of dirs) {
    const fullPath = `${dir}/${bin}`;
    try {
      accessSync(fullPath);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

export function checkPrereqs(
  targetDir: string,
  probes?: Probes
): PrereqReport {
  const nodeVersion = probes?.nodeVersion || process.version;
  const which = probes?.which || defaultWhichSync;

  const checks: PrereqReport["checks"] = [];

  // Check node version >= 20
  const nodeMajor = parseNodeVersion(nodeVersion);
  checks.push({
    name: "node",
    ok: nodeMajor >= 20,
    detail: `node ${nodeVersion} (requires >= 20)`,
    required: true,
  });

  // Check npm
  const npmOk = which("npm");
  checks.push({
    name: "npm",
    ok: npmOk,
    detail: npmOk ? "npm found" : "npm not found in PATH",
    required: true,
  });

  // Check cloudflared (optional)
  const cloudflaredOk = which("cloudflared");
  checks.push({
    name: "cloudflared",
    ok: cloudflaredOk,
    detail: cloudflaredOk ? "cloudflared found" : "cloudflared not found",
    required: false,
  });

  // Check git (optional)
  const gitOk = which("git");
  checks.push({
    name: "git",
    ok: gitOk,
    detail: gitOk ? "git found" : "git not found",
    required: false,
  });

  // Check targetDir writable
  let writableOk = false;
  let writableDetail = "not writable";
  try {
    accessSync(targetDir, constants.W_OK);
    writableOk = true;
    writableDetail = "writable";
  } catch {
    writableDetail = `${targetDir} is not writable`;
  }
  checks.push({
    name: "targetDir writable",
    ok: writableOk,
    detail: writableDetail,
    required: true,
  });

  const ok = checks.filter((c) => c.required).every((c) => c.ok);

  return { ok, checks };
}

export interface NextStepsInput {
  port: number;
  network: string;
  payTo: string;
  devWallet?: string;
  tunnelHostname?: string;
}

export function nextSteps(input: NextStepsInput): string {
  const { port, network, payTo, devWallet, tunnelHostname } = input;
  const lines: string[] = [];
  let step = 1;

  // Faucet step for testnet
  if (network === "eip155:84532") {
    const addr = devWallet || payTo;
    lines.push(
      `${step}. Get test funds: https://faucet.circle.com (Base Sepolia) for ${addr}`
    );
    step++;
  }

  // Mainnet warning
  if (network === "eip155:8453") {
    lines.push(
      `${step}. WARNING: MAINNET — real funds. Use this address: ${payTo}`
    );
    step++;
  }

  // npm start
  lines.push(`${step}. npm start`);
  step++;

  // URLs
  lines.push(
    `${step}. Access the app at:`
  );
  lines.push(`   - Catalog: http://127.0.0.1:${port}/catalog`);
  lines.push(`   - Feed: http://127.0.0.1:${port}/feed`);
  lines.push(`   - Admin: http://127.0.0.1:${port}/admin`);
  step++;

  // Buyer test
  lines.push(
    `${step}. Test a purchase: BUYER_PRIVATE_KEY=<your-key> node scripts/buy.mjs http://127.0.0.1:${port}/<your-route>`
  );
  step++;

  // Tunnel section
  if (tunnelHostname) {
    lines.push(`${step}. Configure cloudflared ingress:`);
    lines.push(`   hostname: ${tunnelHostname}`);
    lines.push(`   service: http://127.0.0.1:${port}`);
    step++;
  }

  return lines.join("\n");
}
