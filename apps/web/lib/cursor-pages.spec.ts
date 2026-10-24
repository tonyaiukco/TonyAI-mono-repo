import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { appendById, isStaleCursor } from "./cursor-pages";

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
