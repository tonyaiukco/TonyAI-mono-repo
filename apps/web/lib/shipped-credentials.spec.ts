import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Everything here reaches the browser or the web image, whatever the
 * environment: a hint hidden by a flag would still ship in the bundle, so the
 * seed accounts stay out of the source altogether. README.md and
 * docs/development/local-setup.md ("Seed users") document them. Latin-1 keeps `public/`'s binaries readable; the patterns are
 * ASCII. Values inlined from the build's environment are out of this scan's reach.
 */
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIPPED_PATHS = [
  ...["app", "components", "hooks", "lib", "messages", "public", "styles"],
  ...["proxy.ts", "instrumentation.ts", "instrumentation-client.ts", "next.config.mjs"],
  "../../packages/shared-types/src",
].map((path) => join(WEB_ROOT, path));
const SEED_ACCOUNT = /TonyAI(-CI)?!2026|tonyai\.local/;

function shippedFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => !name.includes(".spec."))
    .flatMap((name) => shippedFiles(join(path, name)));
}

describe("seed credentials in the shipped web source", () => {
  it("names no seed account or password in any shipped file", () => {
    const files = SHIPPED_PATHS.flatMap(shippedFiles);
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => SEED_ACCOUNT.test(readFileSync(file, "latin1")))).toEqual([]);
  });

  // Until hydration a click is a native GET submit, and a named field would put
  // the password in the URL. The e2e suite proves it, but only runs nightly.
  it.each(["app/login/page.tsx", "app/auth/set-password/set-password-form.tsx"])("%s names no field", (file) => {
    expect(readFileSync(join(WEB_ROOT, file), "utf8")).not.toMatch(/\bname=/);
  });
});
