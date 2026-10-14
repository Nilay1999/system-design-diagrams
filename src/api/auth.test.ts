import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMe, signInErrorMessage, signInUrl } from "./auth";
import { ApiError } from "./client";

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchMe", () => {
  it("returns the user when signed in", async () => {
    mockFetch(200, { handle: "octocat" });
    await expect(fetchMe()).resolves.toEqual({ handle: "octocat" });
    expect(fetch).toHaveBeenCalledWith("/api/me", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("returns null when signed out", async () => {
    mockFetch(401, { message: "not signed in" });
    await expect(fetchMe()).resolves.toBeNull();
  });

  it("rejects when the API isn't there, so account UI can hide", async () => {
    mockFetch(404, { message: "not found" });
    await expect(fetchMe()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("sign-in helpers", () => {
  it("encodes the return path", () => {
    expect(signInUrl("/topics/a?view=doc#x")).toBe("/api/auth/github/login?returnTo=%2Ftopics%2Fa%3Fview%3Ddoc%23x");
  });

  it("maps error reasons to messages, with a fallback", () => {
    expect(signInErrorMessage(null)).toBeUndefined();
    expect(signInErrorMessage("denied")).toMatch(/cancelled/);
    expect(signInErrorMessage("weird")).toBe(signInErrorMessage("server"));
  });
});
