import { describe, expect, it } from "vitest";
import { multiSelectResponse } from "./ExtensionQuestionPanel";

describe("multiSelectResponse", () => {
  it("returns selected option values when no custom answer is entered", () => {
    expect(multiSelectResponse(["one", "three"], "  ")).toEqual(["one", "three"]);
  });

  it("prefers a typed custom answer over selected options", () => {
    expect(multiSelectResponse(["one"], "  another direction  ")).toBe("another direction");
  });
});
