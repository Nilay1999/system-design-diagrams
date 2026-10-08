import { describe, expect, it } from "vitest";

import { brokenStorage, memoryStorage } from "../test/memoryStorage";
import { createStore } from "./storage";

describe("createStore", () => {
  it("namespaces keys", () => {
    const backend = memoryStorage();
    createStore("sdd", () => backend).set("theme", "dark");
    expect(backend.getItem("sdd:theme")).toBe("dark");
  });

  it("round-trips JSON and removes keys", () => {
    const backend = memoryStorage();
    const s = createStore("ns", () => backend);
    s.setJSON("k", { a: [1, 2] });
    expect(s.getJSON("k")).toEqual({ a: [1, 2] });
    s.remove("k");
    expect(s.get("k")).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    const backend = memoryStorage();
    backend.setItem("ns:k", "{not json");
    expect(createStore("ns", () => backend).getJSON("k")).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    const s = createStore("ns", brokenStorage);
    expect(() => s.set("k", "v")).not.toThrow();
    expect(() => s.remove("k")).not.toThrow();
    expect(s.get("k")).toBeNull();
    expect(s.getJSON("k")).toBeNull();
  });
});
