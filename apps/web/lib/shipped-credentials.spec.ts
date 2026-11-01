import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Everything under these folders reaches the browser or the web image, whatever
 * the environment: a hint hidden by a flag would still ship in the bundle, so
 * the seed accounts stay out of the source altogether. They are documented in
 * the README's "Seed users" and printed by `pnpm setup`.
 */
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIPPED_ROOTS = ["app", "components", "lib", "messages"].map((dir) => join(WEB_ROOT, dir));
const SEED_ACCOUNT = /TonyAI!2026|@tonyai\.local/;

function shippedFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shippedFiles(path);
    return /\.(tsx?|json)$/.test(entry.name) && !entry.name.includes(".spec.") ? [path] : [];
  });
}

describe("seed credentials in the shipped web source", () => {
  it("names no seed account or password in any shipped file", () => {
    const files = SHIPPED_ROOTS.flatMap(shippedFiles);
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => SEED_ACCOUNT.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});
