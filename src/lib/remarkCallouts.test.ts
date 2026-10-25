import { describe, expect, it } from "vitest";

import { remarkCallouts } from "./remarkCallouts";

type Node = { type: string; value?: string; children?: Node[]; data?: { hProperties?: Record<string, unknown> } };

const quote = (...children: Node[]): Node => ({ type: "blockquote", children });
const para = (...children: Node[]): Node => ({ type: "paragraph", children });
const text = (value: string): Node => ({ type: "text", value });
const run = (tree: Node) => {
  remarkCallouts()(tree);
  return tree;
};

describe("remarkCallouts", () => {
  it("turns a marked blockquote into a callout and drops the marker", () => {
    const q = quote(para(text("[!WARNING]\nDon't do this."), { type: "strong" }));
    run({ type: "root", children: [q] });
    expect(q.data?.hProperties).toEqual({ className: ["callout", "callout-warning"], dataCallout: "Watch out" });
    expect(q.children![0].children![0]).toEqual(text("Don't do this."));
  });

  it("removes a paragraph that held only the marker", () => {
    const q = quote(para(text("[!tip]")), para(text("Body")));
    run(q);
    expect(q.data?.hProperties?.className).toEqual(["callout", "callout-tip"]);
    expect(q.children).toEqual([para(text("Body"))]);
  });

  it("leaves ordinary blockquotes alone", () => {
    const q = quote(para(text("Just a quote [!NOTE]")));
    run(q);
    expect(q.data).toBeUndefined();
    expect(q.children![0].children![0].value).toBe("Just a quote [!NOTE]");
  });
});
