import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { appendById, isStaleCursor, readPages } from "./cursor-pages";

describe("appendById", () => {
  it("appends a page in order and drops a row already shown", () => {
    const list = [{ id: "a" }, { id: "b" }];
    expect(appendById(list, [{ id: "b" }, { id: "c" }])).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(list).toHaveLength(2); // not mutated
  });
});

describe("isStaleCursor", () => {
  it("is a 400, and nothing else", () => {
    expect(isStaleCursor(new ApiError("bad cursor", 400, "validation_failed"))).toBe(true);
    expect(isStaleCursor(new ApiError("gone", 404, "not_found"))).toBe(false);
    expect(isStaleCursor(new Error("network"))).toBe(false);
  });
});

describe("readPages (UAT round 2, K5: the refrigerant shortcut reads a whole year)", () => {
  const pages: Record<string, { items: { id: string }[]; nextCursor: string | null }> = {
    first: { items: [{ id: "a" }, { id: "b" }], nextCursor: "c2" },
    c2: { items: [{ id: "b" }, { id: "c" }], nextCursor: "c3" },
    c3: { items: [{ id: "d" }], nextCursor: null },
  };
  const read = async (cursor: string | undefined) => pages[cursor ?? "first"];

  it("follows the cursor to the last page, dropping a row seen twice", async () => {
    expect((await readPages(read, 10)).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("stops after its page budget with what it read", async () => {
    expect((await readPages(read, 2)).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
