import type { SimEdge, SimNode, Simulation } from "./types";

/** Where things are drawn. Shared by the SVG view and the layout test. */

export const GRID = { x: 310, y: 150 } as const;
export const NODE = { width: 200, height: 86 } as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const nodeRect = (node: SimNode): Rect => ({ x: node.col * GRID.x, y: node.row * GRID.y, ...NODE });

const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Where the line from the centre of `r` towards `to` crosses its border, moved `gap` px outwards. */
function exit(r: Rect, to: Point, gap: number): Point {
  const c = centre(r);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const scale = Math.min(dx ? r.width / 2 / Math.abs(dx) : Infinity, dy ? r.height / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * scale + (dx / len) * gap, y: c.y + dy * scale + (dy / len) * gap };
}

/** The straight line an edge is drawn along, from border to border. */
export function edgeLine(sim: Simulation, edge: SimEdge): { from: Point; to: Point } {
  const find = (id: string) => {
    const node = sim.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Edge ${edge.from} -> ${edge.to} references unknown node "${id}"`);
    return nodeRect(node);
  };
  const a = find(edge.from);
  const b = find(edge.to);
  return { from: exit(a, centre(b), 4), to: exit(b, centre(a), 8) };
}

/** The box that holds every node, with a margin. */
export function bounds(sim: Simulation, margin = 24): Rect {
  const rects = sim.nodes.map(nodeRect);
  const x = Math.min(...rects.map((r) => r.x)) - margin;
  const y = Math.min(...rects.map((r) => r.y)) - margin;
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) + margin - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) + margin - y,
  };
}

/** Layout mistakes: nodes that overlap, and edges that pass through a node they don't connect. */
export function layoutProblems(sim: Simulation): string[] {
  const problems: string[] = [];
  const inside = (p: Point, r: Rect, inset: number) =>
    p.x > r.x + inset && p.x < r.x + r.width - inset && p.y > r.y + inset && p.y < r.y + r.height - inset;

  sim.nodes.forEach((a, i) => {
    for (const b of sim.nodes.slice(i + 1)) {
      const ra = nodeRect(a);
      const rb = nodeRect(b);
      const w = Math.min(ra.x + ra.width, rb.x + rb.width) - Math.max(ra.x, rb.x);
      const h = Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y);
      if (w > 0 && h > 0) problems.push(`${a.id} overlaps ${b.id}`);
    }
  });

  for (const edge of sim.edges) {
    const { from, to } = edgeLine(sim, edge);
    for (const node of sim.nodes) {
      if (node.id === edge.from || node.id === edge.to) continue;
      const r = nodeRect(node);
      for (let s = 0; s <= 100; s++) {
        const p = { x: from.x + ((to.x - from.x) * s) / 100, y: from.y + ((to.y - from.y) * s) / 100 };
        if (inside(p, r, -6)) {
          problems.push(`edge ${edge.from} -> ${edge.to} passes through or too close to ${node.id}`);
          break;
        }
      }
    }
  }
  return problems;
}
