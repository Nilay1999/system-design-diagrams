import type { Health } from "./types";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A count or rate: "1,920". */
export const count = (n: number) => whole.format(Math.round(n));

/** A rate per second: "1,920 / s". */
export const perSecond = (n: number) => `${count(n)} / s`;

/** A share as a percentage. Values close to 100 keep a decimal, so 99.95 % does not read as 100 %. */
export function percent(share: number): string {
  const p = Math.max(0, Math.min(1, share)) * 100;
  if (p === 100 || p === 0) return `${p} %`;
  if (p > 99.95) return "99.9 %";
  return `${p >= 99 || p < 1 ? p.toFixed(1) : Math.round(p)} %`;
}

/** A duration: "45 s", "3 min", "6.9 h". */
export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** Health of a part from its load as a share of capacity. */
export function healthOf(load: number): Health {
  if (load > 1) return "bad";
  if (load > 0.8) return "busy";
  return "ok";
}

/**
 * How long a request waits at a part that is `load` full, given `base` ms when idle. Waiting
 * grows slowly at first and steeply near 100 % (the usual queueing curve), up to `limit` ms.
 */
export function waitMs(base: number, load: number, limit: number): number {
  if (load >= 1) return limit;
  return Math.min(limit, base / (1 - load));
}
