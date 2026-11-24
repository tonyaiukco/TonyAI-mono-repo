import { describe, expect, it } from "vitest";
import { PUBLIC_PATHS } from "./auth-view";
import { IDLE_TIMEOUT_MS, idleTimeRemaining, shouldExpire } from "./idle-session";

const start = 1_800_000_000_000;
describe("idle session", () => {
  it("ends at exactly one hour", () => {
    expect(idleTimeRemaining(String(start), start + IDLE_TIMEOUT_MS - 1000)).toBe(1000);
    expect(shouldExpire("/", String(start), start + IDLE_TIMEOUT_MS)).toBe(true);
  });

  it("uses the latest activity written by any tab", () => {
    const at = start + IDLE_TIMEOUT_MS - 1000;
    expect(idleTimeRemaining(String(at), start + IDLE_TIMEOUT_MS)).toBe(IDLE_TIMEOUT_MS - 1000);
  });

  it.each([null, "", "invalid", String(start + 1000)])("rejects a saved session with timestamp %s", (value) => {
    expect(shouldExpire("/users", value, start)).toBe(true);
  });

  it.each(PUBLIC_PATHS)("leaves %s accessible without recent activity", (path) => {
    expect(shouldExpire(path, null, start)).toBe(false);
  });
});
