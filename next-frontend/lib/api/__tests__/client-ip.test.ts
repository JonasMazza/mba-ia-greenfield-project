import { beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

const { forwardedFor } = await import("@/lib/api/client-ip");

beforeEach(() => {
  headersMock.mockReset();
});

describe("forwardedFor", () => {
  it("returns the address Next recorded for the browser", async () => {
    headersMock.mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.7" }));
    await expect(forwardedFor()).resolves.toBe("203.0.113.7");
  });

  it("takes the last hop of a chain — the one the nearest proxy appended", async () => {
    headersMock.mockResolvedValue(new Headers({ "x-forwarded-for": "10.9.9.9, 203.0.113.7" }));
    await expect(forwardedFor()).resolves.toBe("203.0.113.7");
  });

  it("returns null when the request carries no address", async () => {
    headersMock.mockResolvedValue(new Headers());
    await expect(forwardedFor()).resolves.toBeNull();
  });

  it("returns null outside a request", async () => {
    headersMock.mockRejectedValue(new Error("`headers` was called outside a request scope"));
    await expect(forwardedFor()).resolves.toBeNull();
  });
});
