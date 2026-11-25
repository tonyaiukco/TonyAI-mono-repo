import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { usePathname } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWatch } from "@/components/auth/session-watch";
import { watchIdleSession } from "./watch-idle-session";

vi.mock("next/navigation", () => ({ usePathname: vi.fn() }));

const hour = 3_600_000;
const start = 1_800_000_000_000;
beforeEach(() => { vi.useFakeTimers().setSystemTime(start); });
afterEach(() => vi.useRealTimers());

class CookieJar extends EventTarget {
  readonly deletions: string[] = [];
  get cookie() { return "sb-tonyai-auth=old; sb-tonyai-auth.0=a; sb-tonyai-auth.1=b; tonyai-locale=en"; }
  set cookie(value: string) { this.deletions.push(value); }
}

function environment() {
  let stored: string | null = String(start);
  const recordActivity = vi.fn((at: number) => { stored = String(at); });
  return {
    tab: new EventTarget(), page: new CookieJar(),
    location: { pathname: "/", replace: vi.fn(), reload: vi.fn() },
    timers: {
      setTimeout: (callback: () => void, delay: number) => Number(setTimeout(callback, delay)),
      clearTimeout: (id?: number) => clearTimeout(id),
    },
    now: Date.now, lastActivity: () => stored, recordActivity,
    changeStorage(value: string | null) { stored = value; },
    withSessionLock: vi.fn((operation: () => Promise<void>) => operation()),
    signOut: vi.fn(async () => {}), onExpire: vi.fn(), onReady: vi.fn(),
  };
}

function input(type: string, trusted: boolean) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "isTrusted", { value: trusted });
  return event;
}

describe("protected page idle gate", () => {
  it("withholds the protected subtree at first render and renders a public page immediately", () => {
    const gate = createElement(SessionWatch, { children: "page content" });
    vi.mocked(usePathname).mockReturnValue("/");
    expect(renderToString(gate)).not.toContain("page content");
    vi.mocked(usePathname).mockReturnValue("/login");
    expect(renderToString(gate)).toContain("page content");
  });

  it("expires on load before opening the gate and clears every session chunk on logout failure", async () => {
    const env = environment();
    env.changeStorage(null);
    env.signOut.mockRejectedValue(new Error("offline"));
    watchIdleSession(env);
    expect(env.onExpire).toHaveBeenCalledOnce();
    expect(env.onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.signOut).toHaveBeenCalledOnce();
    expect(env.page.deletions).toEqual(["sb-tonyai-auth", "sb-tonyai-auth.0", "sb-tonyai-auth.1"]
      .map(name => name + "=; Path=/; Max-Age=0; SameSite=Lax"));
    expect(env.location.replace).toHaveBeenCalledWith("/login?reason=idle");
  });

  it("reschedules the deadline immediately on another tab's storage notification", async () => {
    const env = environment();
    const schedule = vi.spyOn(env.timers, "setTimeout");
    watchIdleSession(env);
    expect(env.onReady).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(hour - 1000);
    env.changeStorage(String(Date.now()));
    schedule.mockClear();
    env.tab.dispatchEvent(Object.assign(new Event("storage"), { key: "tonyai-last-activity" }));
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), hour);
    await vi.advanceTimersByTimeAsync(hour - 1);
    expect(env.onExpire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(env.location.replace).toHaveBeenCalledWith("/login?reason=idle");
  });

  it.each(["pointerdown", "keydown", "wheel", "scroll", "touchstart"])("counts only trusted %s events", type => {
    const env = environment();
    const stop = watchIdleSession(env);
    vi.advanceTimersByTime(1000);
    env.tab.dispatchEvent(input(type, false));
    expect(env.recordActivity).not.toHaveBeenCalled();
    env.tab.dispatchEvent(input(type, true));
    expect(env.recordActivity).toHaveBeenCalledWith(start + 1000);
    stop?.();
  });

  it("coalesces rapid input and preserves the final event's time", () => {
    const env = environment();
    watchIdleSession(env);
    for (const delta of [100, 150]) {
      vi.advanceTimersByTime(delta);
      env.tab.dispatchEvent(input("keydown", true));
    }
    expect(env.recordActivity).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(env.recordActivity).toHaveBeenCalledTimes(1);
    expect(env.recordActivity).toHaveBeenCalledWith(start + 250);
  });

  it("rechecks under the lock and reloads a new sign-in without revoking it", async () => {
    const env = environment();
    let unlock!: () => void;
    const waiting = new Promise<void>(resolve => { unlock = resolve; });
    env.withSessionLock.mockImplementation(async operation => { await waiting; await operation(); });
    env.changeStorage(null);
    watchIdleSession(env);
    expect(env.withSessionLock).toHaveBeenCalledOnce();
    expect(env.signOut).not.toHaveBeenCalled();
    env.changeStorage(String(Date.now()));
    unlock();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.location.reload).toHaveBeenCalledOnce();
    expect(env.signOut).not.toHaveBeenCalled();
    expect(env.page.deletions).toEqual([]);
    expect(env.location.replace).not.toHaveBeenCalled();
  });
});
