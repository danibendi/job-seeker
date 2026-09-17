import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "../src/lib/safe-url";

describe("safeHttpUrl", () => {
  it("allows only absolute HTTP and HTTPS URLs", () => {
    expect(safeHttpUrl("https://meet.example/room")).toBe("https://meet.example/room");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });
});
