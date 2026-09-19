import { describe, expect, it } from "vitest";
import { mergeAnimatedItems } from "./use-animated-list";

describe("mergeAnimatedItems", () => {
  it("keeps a removed item in place only while its exit is active", () => {
    const current = [{ id: "one", label: "old" }, { id: "two", label: "two" }];
    const incoming = [{ id: "two", label: "updated" }, { id: "three", label: "three" }];

    expect(mergeAnimatedItems(incoming, current, new Set(["one"]))).toEqual([
      { id: "one", label: "old" },
      { id: "two", label: "updated" },
      { id: "three", label: "three" },
    ]);
    expect(mergeAnimatedItems(incoming, current, new Set())).toEqual([
      { id: "two", label: "updated" },
      { id: "three", label: "three" },
    ]);
  });
});
