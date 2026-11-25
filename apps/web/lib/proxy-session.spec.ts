import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { proxy } from "../proxy";

vi.mock("@supabase/ssr", async importOriginal => ({
  ...await importOriginal<typeof import("@supabase/ssr")>(),
  createServerClient: (_url: string, _key: string, { cookies }: {
    cookies: { setAll(updates: { name: string; value: string; options: { maxAge: number; path: string } }[]): void };
  }) => ({
    auth: {
      async getUser() {
        cookies.setAll([{ name: "sb-tonyai-auth.0", value: "", options: { maxAge: 0, path: "/" } }]);
        return { data: { user: null } };
      },
    },
  }),
}));

describe("proxy handling an ended session", () => {
  it("forwards Auth cookie deletion and its reason to the protected request's redirect", async () => {
    const request = new NextRequest("http://localhost/reports", { headers: { cookie: "sb-tonyai-auth.0=expired" } });
    const response = await proxy(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login?reason=session_ended");
    expect(response.cookies.get("sb-tonyai-auth.0")).toMatchObject({ value: "", maxAge: 0, path: "/" });
  });
});
