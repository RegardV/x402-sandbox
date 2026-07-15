import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { listSafe, resolveSafe } from "../src/resolve-safe.js";

const dir = mkdtempSync(join(tmpdir(), "resolve-safe-"));
const outside = mkdtempSync(join(tmpdir(), "resolve-safe-outside-"));

// fixtures
writeFileSync(join(dir, "index.html"), "hi");
mkdirSync(join(dir, "docs", "guides"), { recursive: true });
writeFileSync(join(dir, "docs", "guides", "intro.md"), "intro");
writeFileSync(join(dir, "%2e%2e%2fsecret.txt"), "literal name, not traversal");
writeFileSync(join(dir, ".env"), "SECRET=1");
mkdirSync(join(dir, "docs", ".git"), { recursive: true });
writeFileSync(join(dir, "docs", ".git", "config"), "git");
writeFileSync(join(dir, "backup.env"), "SECRET=2");
writeFileSync(join(dir, "server.KEY"), "key");
writeFileSync(join(outside, "target.txt"), "outside");
symlinkSync(join(outside, "target.txt"), join(dir, "escape.txt"));
symlinkSync(join(dir, "index.html"), join(dir, "alias.html"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveSafe", () => {
  it("resolves an allowed nested file to its realpath", () => {
    expect(resolveSafe(dir, "/docs/guides/intro.md")).toBe(
      realpathSync(join(dir, "docs", "guides", "intro.md")),
    );
  });

  it("returns null for empty and root paths", () => {
    expect(resolveSafe(dir, "")).toBeNull();
    expect(resolveSafe(dir, "/")).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(resolveSafe(dir, "/nope.txt")).toBeNull();
  });

  it("returns null for a directory", () => {
    expect(resolveSafe(dir, "/docs")).toBeNull();
  });

  it("returns null for ../ traversal", () => {
    expect(resolveSafe(dir, "/../" + join(outside, "target.txt"))).toBeNull();
    expect(resolveSafe(dir, "/docs/../../secret")).toBeNull();
  });

  it("treats '..%2F' as a literal filename (no double-decoding)", () => {
    expect(resolveSafe(dir, "/%2e%2e%2fsecret.txt")).toBe(
      realpathSync(join(dir, "%2e%2e%2fsecret.txt")),
    );
  });

  it("returns null for dotfile at root", () => {
    expect(resolveSafe(dir, "/.env")).toBeNull();
  });

  it("returns null for nested dot-directory", () => {
    expect(resolveSafe(dir, "/docs/.git/config")).toBeNull();
  });

  it("denies extensions case-insensitively anywhere", () => {
    expect(resolveSafe(dir, "/backup.env")).toBeNull();
    expect(resolveSafe(dir, "/server.KEY")).toBeNull();
  });

  it("returns null for a symlink pointing outside contentDir", () => {
    expect(resolveSafe(dir, "/escape.txt")).toBeNull();
  });

  it("resolves a symlink pointing inside contentDir", () => {
    expect(resolveSafe(dir, "/alias.html")).toBe(
      realpathSync(join(dir, "index.html")),
    );
  });
});

describe("listSafe", () => {
  it("skips dotfiles/dot-dirs, denied extensions, and escaping symlinks; sorted relative paths", () => {
    expect(listSafe(dir)).toEqual(
      ["%2e%2e%2fsecret.txt", "alias.html", "docs/guides/intro.md", "index.html"].sort(),
    );
  });
});
