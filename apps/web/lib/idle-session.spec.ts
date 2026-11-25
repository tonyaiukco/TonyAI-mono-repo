import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_PATHS } from "./auth-view";
import { IDLE_TIMEOUT_MS, idleTimeRemaining, shouldExpire, startInteractiveSession } from "./idle-session";

const start = 1_800_000_000_000;
describe("idle session", () => {
  it("ends at exactly one hour", () => {
    expect(IDLE_TIMEOUT_MS).toBe(3_600_000);
    expect(idleTimeRemaining(String(start), start + 59 * 60_000 + 59_000)).toBe(1000);
    expect(shouldExpire("/", String(start), start + 60 * 60_000)).toBe(true);
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

describe("interactive sign-in", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    { session: {}, error: null, writes: 1 },
    { session: {}, error: "exchange failed", writes: 0 },
    { session: null, error: null, writes: 0 },
  ])("records only a successful exchange, inside the session lock", async ({ session, error, writes }) => {
    vi.useFakeTimers().setSystemTime(start);
    let held = false;
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => {
      held = true;
      try { return await operation(); } finally { held = false; }
    });
    const setItem = vi.fn(() => expect(held).toBe(true));
    vi.stubGlobal("navigator", { locks: { request } });
    vi.stubGlobal("window", { localStorage: { setItem } });
    const result = { data: { session }, error };
    expect(await startInteractiveSession(async () => {
      expect(held).toBe(true);
      return result;
    })).toBe(result);
    expect(request).toHaveBeenCalledWith("tonyai-session-change", expect.any(Function));
    expect(setItem).toHaveBeenCalledTimes(writes);
    if (writes) expect(setItem).toHaveBeenCalledWith("tonyai-last-activity", String(start));
  });
});
