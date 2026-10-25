import type { Skeleton } from "./dsl";

/**
 * Finds layout mistakes in a built diagram: filled boxes (nodes, panels, tables, notes) that overlap
 * each other, boxes or zones that cross a zone's border instead of sitting inside or outside it, and
 * connecting arrows that pass through a box they don't connect. Labels aren't checked.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  group?: string;
  label: string;
}

/** Overlaps smaller than this (px) are ignored: hand-drawn strokes touch. */
const SLACK = 2;

function rectOf(el: Skeleton): Rect | undefined {
  if (el.type !== "rectangle" && el.type !== "ellipse") return undefined;
  const { x = 0, y = 0, width = 0, height = 0 } = el as { x?: number; y?: number; width?: number; height?: number };
  const label = "id" in el && el.id ? el.id : `${el.type}@${Math.round(x)},${Math.round(y)}`;
  return { x, y, width, height, group: el.groupIds?.[0], label };
}

const isFilled = (el: Skeleton) => "backgroundColor" in el && el.backgroundColor !== undefined && el.backgroundColor !== "transparent";
const isZone = (el: Skeleton) => el.type === "rectangle" && !isFilled(el) && "strokeStyle" in el && el.strokeStyle === "dashed";

function overlap(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > SLACK && h > SLACK;
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - SLACK &&
  inner.y >= outer.y - SLACK &&
  inner.x + inner.width <= outer.x + outer.width + SLACK &&
  inner.y + inner.height <= outer.y + outer.height + SLACK;

interface Arrow {
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

/** Arrows bound to two nodes (DSL edges), with absolute points. Sequence-diagram arrows aren't bound. */
function arrowsOf(elements: readonly Skeleton[]): Arrow[] {
  return elements.flatMap((el) => {
    if (el.type !== "arrow" || !el.start || !el.end || !("id" in el.start) || !("id" in el.end)) return [];
    const { x = 0, y = 0, points = [] } = el as { x?: number; y?: number; points?: readonly (readonly number[])[] };
    return [{ from: String(el.start.id), to: String(el.end.id), points: points.map(([px, py]) => ({ x: x + px, y: y + py })) }];
  });
}

/** Inset so arrows that merely graze a corner, or start at a box edge, don't count. */
const GRAZE = 6;

function pierces(a: Arrow, r: Rect): boolean {
  for (let i = 1; i < a.points.length; i++) {
    const p = a.points[i - 1];
    const q = a.points[i];
    const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 4);
    for (let s = 0; s <= steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps;
      const y = p.y + ((q.y - p.y) * s) / steps;
      if (x > r.x + GRAZE && x < r.x + r.width - GRAZE && y > r.y + GRAZE && y < r.y + r.height - GRAZE) return true;
    }
  }
  return false;
}

export function layoutProblems(elements: readonly Skeleton[]): string[] {
  const boxes = elements.filter(isFilled).map(rectOf).filter((r): r is Rect => !!r);
  const zones = elements.filter(isZone).map(rectOf).filter((r): r is Rect => !!r);
  const problems: string[] = [];

  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1)) {
      if (a.group && a.group === b.group) continue;
      if (overlap(a, b)) problems.push(`${a.label} overlaps ${b.label}`);
    }
  });
  const groupOf = new Map(boxes.map((b) => [b.label, b.group]));
  for (const a of arrowsOf(elements)) {
    const ends = new Set([a.from, a.to, groupOf.get(a.from), groupOf.get(a.to)].filter(Boolean));
    for (const b of boxes) {
      if (ends.has(b.label) || (b.group && ends.has(b.group))) continue;
      if (pierces(a, b)) problems.push(`arrow ${a.from} → ${a.to} passes through ${b.label}`);
    }
  }
  zones.forEach((z, i) => {
    for (const b of boxes) {
      if (overlap(z, b) && !contains(z, b)) problems.push(`${b.label} crosses the border of zone ${z.label}`);
    }
    for (const other of zones.slice(i + 1)) {
      if (overlap(z, other) && !contains(z, other) && !contains(other, z)) problems.push(`zones ${z.label} and ${other.label} cross`);
    }
  });
  return problems;
}
