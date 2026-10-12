import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once, with the last arguments, after calls stop", () => {
    const fn = vi.fn();
    const d = debounce(() => fn, 100);
    d(1);
    vi.advanceTimersByTime(60);
    d(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("uses the function current at call time, not at fire time", () => {
    const saved: string[] = [];
    let key = "tab-a";
    const d = debounce(() => {
      const k = key;
      return (v: string) => saved.push(`${k}=${v}`);
    }, 100);
    d("drawing on a");
    key = "tab-b"; // the user switches tabs before the save fires
    vi.advanceTimersByTime(100);
    expect(saved).toEqual(["tab-a=drawing on a"]);
  });

  it("flush runs the pending call immediately; cancel drops it", () => {
    const fn = vi.fn();
    const d = debounce(() => fn, 100);
    d("x");
    d.flush();
    expect(fn).toHaveBeenCalledExactlyOnceWith("x");
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    d("y");
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
