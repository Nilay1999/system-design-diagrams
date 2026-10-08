import { describe, expect, it } from "vitest";

import { topic } from "../test/fixtures";
import { isNonDefaultView, parseLegacyHash, topicPath } from "./paths";

describe("topicPath", () => {
  const t = topic();

  it("leaves the default tab out of the URL", () => {
    expect(topicPath(t)).toBe("/topics/url-shortener");
    expect(topicPath(t, "architecture")).toBe("/topics/url-shortener");
  });

  it("includes any other tab", () => {
    expect(topicPath(t, "redirect-flow")).toBe("/topics/url-shortener/redirect-flow");
  });
});

describe("isNonDefaultView", () => {
  it("accepts only tabs after the first", () => {
    const t = topic();
    expect(isNonDefaultView(t, "redirect-flow")).toBe(true);
    expect(isNonDefaultView(t, "architecture")).toBe(false);
    expect(isNonDefaultView(t, "nope")).toBe(false);
  });
});

describe("parseLegacyHash", () => {
  it.each([
    ["#/rate-limiter/check-flow", { slug: "rate-limiter", view: "check-flow" }],
    ["#/rate-limiter", { slug: "rate-limiter", view: undefined }],
    ["#rate-limiter", { slug: "rate-limiter", view: undefined }],
    ["", { slug: undefined, view: undefined }],
  ])("%j", (hash, expected) => {
    expect(parseLegacyHash(hash)).toEqual(expected);
  });
});
