import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const DENIED_EXTENSIONS = new Set([".env", ".key", ".pem"]);

function isDeniedName(segment: string): boolean {
  return (
    segment.startsWith(".") ||
    DENIED_EXTENSIONS.has(path.extname(segment).toLowerCase())
  );
}

/** Returns the absolute realpath of an existing regular file inside contentDir,
 *  or null if the path is missing, denied, or escapes the directory. Never throws. */
export function resolveSafe(contentDir: string, requestPath: string): string | null {
  const segments = requestPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.some(isDeniedName)) return null;
  try {
    const rootReal = realpathSync(contentDir);
    const fileReal = realpathSync(path.join(contentDir, ...segments));
    if (!fileReal.startsWith(rootReal + path.sep)) return null;
    return statSync(fileReal).isFile() ? fileReal : null;
  } catch {
    return null;
  }
}

/** Same deny rules applied to a directory listing: relative posix paths of
 *  allowed regular files under contentDir, recursive, sorted. Never throws. */
export function listSafe(contentDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(contentDir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((rel) => resolveSafe(contentDir, "/" + rel) !== null)
    .sort();
}
