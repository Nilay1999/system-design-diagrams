import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawLinearElement } from "@excalidraw/excalidraw/element/types";

/**
 * A tiny DSL for authoring architecture diagrams as code.
 *
 * Nodes are placed on a grid (col/row, fractions allowed) so diagrams stay
 * aligned without hand-tuning pixel coordinates. Edges bind to nodes by id,
 * so Excalidraw keeps arrows attached when users drag boxes around.
 */

export type NodeKind =
  | "client"
  | "edge" // CDN, DNS, API gateway, load balancer
  | "service"
  | "worker"
  | "db"
  | "cache"
  | "queue"
  | "storage"
  | "external";

interface KindStyle {
  shape: "rectangle" | "ellipse" | "diamond";
  backgroundColor: string;
  strokeColor: string;
  strokeStyle?: "solid" | "dashed" | "dotted";
}

const STYLES: Record<NodeKind, KindStyle> = {
  client: { shape: "rectangle", backgroundColor: "#a5d8ff", strokeColor: "#1971c2" },
  edge: { shape: "rectangle", backgroundColor: "#d0bfff", strokeColor: "#6741d9" },
  service: { shape: "rectangle", backgroundColor: "#b2f2bb", strokeColor: "#2f9e44" },
  worker: { shape: "rectangle", backgroundColor: "#c3fae8", strokeColor: "#0c8599" },
  db: { shape: "ellipse", backgroundColor: "#ffec99", strokeColor: "#e67700" },
  cache: { shape: "ellipse", backgroundColor: "#ffc9c9", strokeColor: "#e03131" },
  queue: { shape: "rectangle", backgroundColor: "#ffd8a8", strokeColor: "#e8590c", strokeStyle: "dashed" },
  storage: { shape: "ellipse", backgroundColor: "#eebefa", strokeColor: "#9c36b5" },
  external: { shape: "rectangle", backgroundColor: "#e9ecef", strokeColor: "#495057", strokeStyle: "dashed" },
};

export const LEGEND: { kind: NodeKind; label: string }[] = [
  { kind: "client", label: "Client" },
  { kind: "edge", label: "Edge / Gateway / LB" },
  { kind: "service", label: "Service" },
  { kind: "worker", label: "Async worker" },
  { kind: "queue", label: "Queue / Stream" },
  { kind: "cache", label: "Cache" },
  { kind: "db", label: "Database" },
  { kind: "storage", label: "Object / Blob store" },
  { kind: "external", label: "Third party" },
];

export function kindColor(kind: NodeKind): { bg: string; stroke: string } {
  return { bg: STYLES[kind].backgroundColor, stroke: STYLES[kind].strokeColor };
}

const GRID_X = 290;
const GRID_Y = 150;
const NODE_W = 180;
const NODE_H = 72;

interface NodeOpts {
  /** Width/height in grid units (1 = one default node). */
  w?: number;
  h?: number;
}

interface EdgeOpts {
  /** Dashed line — use for async / eventual flows. */
  async?: boolean;
  /** Arrowheads on both ends. */
  both?: boolean;
  color?: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  shape: KindStyle["shape"];
}

/** Gap between an arrow tip and the shape it points at. */
const ARROW_GAP = 6;

/**
 * Where the ray from the box centre in direction (dx, dy) leaves the shape,
 * as a multiple of (dx, dy).
 */
function exitScale(box: Box, dx: number, dy: number): number {
  const hw = box.width / 2;
  const hh = box.height / 2;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  switch (box.shape) {
    case "ellipse":
      return 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
    case "diamond":
      return 1 / (ax / hw + ay / hh);
    case "rectangle":
      return Math.min(ax ? hw / ax : Infinity, ay ? hh / ay : Infinity);
  }
}

/**
 * Excalidraw's skeleton API records arrow bindings but does not route the
 * arrow, so compute a straight centre-to-centre segment clipped to both shapes.
 */
function route(a: Box, b: Box) {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy) || 1;
  const gx = (dx / len) * ARROW_GAP;
  const gy = (dy / len) * ARROW_GAP;
  const sa = exitScale(a, dx, dy);
  const sb = exitScale(b, -dx, -dy);
  const start = { x: ca.x + dx * sa + gx, y: ca.y + dy * sa + gy };
  const end = { x: cb.x - dx * sb - gx, y: cb.y - dy * sb - gy };
  return { start, end };
}

export class Diagram {
  private zones: ExcalidrawElementSkeleton[] = [];
  private nodes: ExcalidrawElementSkeleton[] = [];
  private edges: ExcalidrawElementSkeleton[] = [];
  private texts: ExcalidrawElementSkeleton[] = [];
  private boxes = new Map<string, Box>();

  constructor(
    private readonly title?: string,
    private readonly subtitle?: string,
  ) {}

  /** Add a component box. `col`/`row` are grid coordinates. */
  node(id: string, label: string, col: number, row: number, kind: NodeKind = "service", opts: NodeOpts = {}): this {
    if (this.boxes.has(id)) throw new Error(`Duplicate node id "${id}"`);
    const style = STYLES[kind];
    const width = NODE_W + ((opts.w ?? 1) - 1) * GRID_X;
    const height = NODE_H + ((opts.h ?? 1) - 1) * GRID_Y;
    const box: Box = { x: col * GRID_X, y: row * GRID_Y, width, height, shape: style.shape };
    this.boxes.set(id, box);
    this.nodes.push({
      type: style.shape,
      id,
      x: box.x,
      y: box.y,
      width,
      height,
      backgroundColor: style.backgroundColor,
      strokeColor: style.strokeColor,
      strokeStyle: style.strokeStyle ?? "solid",
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      roundness: style.shape === "rectangle" ? { type: 3 } : null,
      label: { text: label, fontSize: 16, strokeColor: "#1e1e1e" },
    });
    return this;
  }

  /** Connect two nodes with a bound arrow. */
  edge(from: string, to: string, label?: string, opts: EdgeOpts = {}): this {
    const a = this.boxes.get(from);
    const b = this.boxes.get(to);
    if (!a || !b) throw new Error(`Edge ${from} -> ${to} references an unknown node`);
    const { start, end } = route(a, b);
    const w = end.x - start.x;
    const h = end.y - start.y;
    this.edges.push({
      type: "arrow",
      x: start.x,
      y: start.y,
      width: Math.abs(w),
      height: Math.abs(h),
      points: [
        [0, 0],
        [w, h],
      ] as unknown as ExcalidrawLinearElement["points"], // LocalPoint is a branded tuple
      start: { id: from },
      end: { id: to },
      strokeColor: opts.color ?? (opts.async ? "#e8590c" : "#495057"),
      strokeStyle: opts.async ? "dashed" : "solid",
      strokeWidth: 2,
      startArrowhead: opts.both ? "arrow" : null,
      endArrowhead: "arrow",
      label: label ? { text: label, fontSize: 14, strokeColor: "#343a40" } : undefined,
    });
    return this;
  }

  /**
   * A labelled dashed boundary drawn behind nodes (e.g. "Data layer", "Region A").
   * Coordinates are in grid units and describe the region to enclose.
   */
  zone(label: string, col: number, row: number, cols: number, rows: number, color = "#adb5bd"): this {
    const pad = 30;
    const x = col * GRID_X - pad;
    const y = row * GRID_Y - pad - 16;
    const width = (cols - 1) * GRID_X + NODE_W + pad * 2;
    const height = (rows - 1) * GRID_Y + NODE_H + pad * 2 + 16;
    this.zones.push({
      type: "rectangle",
      x,
      y,
      width,
      height,
      strokeColor: color,
      backgroundColor: "transparent",
      strokeStyle: "dashed",
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3 },
    });
    this.texts.push({ type: "text", x: x + 12, y: y + 8, text: label, fontSize: 14, strokeColor: color });
    return this;
  }

  /** Free-floating annotation. */
  note(text: string, col: number, row: number, color = "#868e96"): this {
    this.texts.push({ type: "text", x: col * GRID_X, y: row * GRID_Y, text, fontSize: 14, strokeColor: color });
    return this;
  }

  /** Numbered step list, useful for describing a request flow beside the diagram. */
  steps(title: string, steps: string[], col: number, row: number): this {
    const body = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    this.texts.push({
      type: "text",
      x: col * GRID_X,
      y: row * GRID_Y,
      text: `${title}\n${body}`,
      fontSize: 14,
      strokeColor: "#495057",
    });
    return this;
  }

  build(): ExcalidrawElementSkeleton[] {
    // Place the heading above whatever sits highest, zones included.
    const boxes = [...this.boxes.values()];
    const top = Math.min(0, ...boxes.map((b) => b.y)) - 50;
    const left = Math.min(0, ...boxes.map((b) => b.x)) - 30;
    const heading: ExcalidrawElementSkeleton[] = [];
    if (this.title) {
      heading.push({ type: "text", x: left, y: top - 110, text: this.title, fontSize: 36, strokeColor: "#1e1e1e" });
    }
    if (this.subtitle) {
      heading.push({ type: "text", x: left, y: top - 58, text: this.subtitle, fontSize: 18, strokeColor: "#868e96" });
    }
    // Order matters for z-index: zones at the back, labels on top.
    return [...this.zones, ...this.nodes, ...this.edges, ...this.texts, ...heading];
  }
}
