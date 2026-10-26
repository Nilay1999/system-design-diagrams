import { describe, expect, it } from "vitest";

import { highlight, type Token } from "./highlight";

const kinds = (tokens: Token[]) => tokens.filter((t) => t.kind).map((t) => [t.kind, t.text]);
const text = (tokens: Token[]) => tokens.map((t) => t.text).join("");

describe("highlight", () => {
  it("leaves unknown languages alone", () => {
    expect(highlight("a: b # c", undefined)).toEqual([{ text: "a: b # c" }]);
    expect(highlight("a: b", "text")).toEqual([{ text: "a: b" }]);
  });

  it("marks YAML keys, strings and comments", () => {
    const tokens = highlight('  replicas: 3   # three\n  - name: "app"\nhttpGet: { path: /x, port: 8080 }', "yaml");
    expect(kinds(tokens)).toEqual([
      ["key", "replicas"],
      ["comment", "# three"],
      ["key", "name"],
      ["string", '"app"'],
      ["key", "httpGet"],
      ["key", "path"],
      ["key", "port"],
    ]);
  });

  it("does not treat a # inside quotes or a word as a comment", () => {
    expect(kinds(highlight("channel: \"#team-orders\"", "yaml"))).toEqual([
      ["key", "channel"],
      ["string", '"#team-orders"'],
    ]);
    expect(kinds(highlight("image: repo/app#1", "yaml"))).toEqual([["key", "image"]]);
  });

  it("marks shell commands, flags and comments", () => {
    const tokens = highlight("kubectl get pods -n fooddash --watch   # live", "bash");
    expect(kinds(tokens)).toEqual([
      ["command", "kubectl"],
      ["flag", "-n"],
      ["flag", "--watch"],
      ["comment", "# live"],
    ]);
  });

  it("never changes the text", () => {
    const src = "a: 'x' # y\n\n  - b: c\nkubectl x";
    expect(text(highlight(src, "yaml"))).toBe(src);
    expect(text(highlight(src, "bash"))).toBe(src);
  });
});
