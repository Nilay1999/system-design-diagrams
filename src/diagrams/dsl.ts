import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawLinearElement } from "@excalidraw/excalidraw/element/types";

/**
 * A tiny DSL for authoring architecture diagrams as code.
 *
 * - `Diagram` lays out component boxes on a grid (col/row, fractions allowed) so
 *   diagrams stay aligned without hand-tuning pixel coordinates. Edges bind to
 *   nodes by id, so Excalidraw keeps arrows attached when users drag boxes around.
 * - `Sequence` draws a sequence diagram: participants with lifelines, numbered
 *   messages, notes and alt/opt/loop blocks.
 *
 * A topic has several views (architecture, request flows, deep dives), each one
 * a `DiagramSpec`.
 */

export type Skeleton = ExcalidrawElementSkeleton;

export interface DiagramSpec {
  /** Stable id, used in `#diagram/<id>` links from the docs and for saved edits. */
  id: string;
  /** Tab label. */
  name: string;
  build: () => Skeleton[];
}

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
  shape: "rectangle" | "ellipse";
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

/**
 * Fonts used for diagram text. Ids match Excalidraw's FONT_FAMILY
 * (1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont, 6 Nunito, 8 Comic Shanns, 9 Liberation Sans).
 * Hard-coded rather than imported so this module doesn't pull Excalidraw into the main bundle.
 */
export const DIAGRAM_FONT = { id: 6, name: "Nunito" } as const;
export const MONO_FONT = { id: 3, name: "Cascadia" } as const;

const TEXT = "#1e1e1e";
const MUTED = "#495057";
const FAINT = "#868e96";

// ---------------------------------------------------------------------------
// Text metrics. Excalidraw measures text itself; these estimates only decide
// where to wrap lines and how tall boxes must be. They err on the wide side.
// ---------------------------------------------------------------------------

const MONO_CHAR = 0.6; // Cascadia Code advance, in ems
const SANS_LINE = 1.25; // Excalidraw line height for Nunito
const MONO_LINE = 1.2; // Excalidraw line height for Cascadia
/** Excalidraw pads bound text by this much on every side. */
const BOUND_PAD = 5;

/** Approximate Nunito advance widths in ems, by character class (slightly generous). */
function sansAdvance(ch: string): number {
  if (ch === " ") return 0.26;
  if ("iljI.,:;'|!()[]{}".includes(ch)) return 0.3;
  if ("mwMW".includes(ch)) return 0.82;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[0-9]/.test(ch)) return 0.57;
  if (/[a-z]/.test(ch)) return 0.51;
  return 0.6; // symbols, arrows, non-Latin
}

/** Estimated rendered width of one line of text, in px. */
export function textWidth(line: string, fontSize: number, mono = false): number {
  if (mono) return line.length * fontSize * MONO_CHAR;
  let em = 0;
  for (const ch of line) em += sansAdvance(ch);
  return em * fontSize;
}

/** Greedy word wrap to a pixel width; explicit newlines are kept. */
export function wrap(text: string, maxWidth: number, fontSize: number, mono = false): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || textWidth(next, fontSize, mono) <= maxWidth) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  shape: KindStyle["shape"];
}

interface Point {
  x: number;
  y: number;
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
  if (box.shape === "ellipse") return 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  return Math.min(ax ? hw / ax : Infinity, ay ? hh / ay : Infinity);
}

const centre = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Point where the segment from the centre of `box` towards `toward` leaves the shape, plus a small gap. */
function clip(box: Box, toward: Point): Point {
  const c = centre(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const s = exitScale(box, dx, dy);
  return { x: c.x + dx * s + (dx / len) * ARROW_GAP, y: c.y + dy * s + (dy / len) * ARROW_GAP };
}

/**
 * Excalidraw's skeleton API records arrow bindings but does not route the
 * arrow, so compute the polyline ourselves: centre to centre through any
 * waypoints, clipped to both shapes.
 */
function route(a: Box, b: Box, via: Point[]): Point[] {
  const first = via[0] ?? centre(b);
  const last = via[via.length - 1] ?? centre(a);
  return [clip(a, first), ...via, clip(b, last)];
}

type Points = ExcalidrawLinearElement["points"];

function linear(points: Point[]): { x: number; y: number; width: number; height: number; points: Points } {
  const [p0] = points;
  const rel = points.map((p) => [p.x - p0.x, p.y - p0.y]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return {
    x: p0.x,
    y: p0.y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: rel as unknown as Points, // LocalPoint is a branded tuple
  };
}

/** An invisible rectangle whose only job is to hold (and centre / wrap) a piece of text. */
function textBox(
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  o: { fontSize: number; color: string; align?: "left" | "center"; valign?: "top" | "middle"; mono?: boolean; groupIds?: string[] },
): Skeleton {
  return {
    type: "rectangle",
    x,
    y,
    width,
    height,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    strokeWidth: 1,
    roughness: 0,
    groupIds: o.groupIds,
    label: {
      text,
      fontFamily: o.mono ? MONO_FONT.id : DIAGRAM_FONT.id,
      fontSize: o.fontSize,
      strokeColor: o.color,
      textAlign: o.align ?? "center",
      verticalAlign: o.valign ?? "middle",
    },
  };
}

function freeText(x: number, y: number, text: string, fontSize: number, color: string, mono = false): Skeleton {
  return { type: "text", x, y, text, fontFamily: mono ? MONO_FONT.id : DIAGRAM_FONT.id, fontSize, strokeColor: color };
}

// ---------------------------------------------------------------------------
// Panels (notes / callouts) — shared by Diagram and Sequence
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "warn" | "good" | "bad";

const TONES: Record<Tone, { bg: string; stroke: string; title: string }> = {
  neutral: { bg: "#f8f9fa", stroke: "#adb5bd", title: "#343a40" },
  info: { bg: "#e7f5ff", stroke: "#74c0fc", title: "#1864ab" },
  warn: { bg: "#fff9db", stroke: "#fcc419", title: "#e67700" },
  good: { bg: "#ebfbee", stroke: "#8ce99a", title: "#2b8a3e" },
  bad: { bg: "#fff5f5", stroke: "#ffa8a8", title: "#c92a2a" },
};

interface PanelOpts {
  /** Width in pixels (default 300). */
  width?: number;
  tone?: Tone;
  /** Prefix lines with 1., 2., 3. … */
  numbered?: boolean;
  /** Monospace body, for code or pseudo-code. */
  mono?: boolean;
}

/** A rounded box with an optional title and wrapped body lines. Returns the elements and the box. */
function panel(g: string, title: string | undefined, lines: string[], x: number, y: number, o: PanelOpts): { els: Skeleton[]; box: Box } {
  const width = o.width ?? 300;
  const tone = TONES[o.tone ?? "neutral"];
  const inner = width - 24;
  const bodySize = 13;
  const titleSize = 15;
  const body = lines
    .map((l, i) => (o.numbered ? `${i + 1}. ${l}` : l))
    .flatMap((l) => (o.mono ? [l] : wrap(l, inner - 2 * BOUND_PAD, bodySize)));
  const titleLines = title ? wrap(title, inner - 2 * BOUND_PAD, titleSize) : [];
  const titleH = titleLines.length * titleSize * SANS_LINE;
  const bodyH = body.length * bodySize * (o.mono ? MONO_LINE : SANS_LINE);
  const gap = title && body.length ? 6 : 0;
  const height = 12 + titleH + gap + bodyH + 12 + (title ? BOUND_PAD * 2 : 0) + (body.length ? BOUND_PAD * 2 : 0);
  const els: Skeleton[] = [
    {
      type: "rectangle",
      x,
      y,
      width,
      height,
      backgroundColor: tone.bg,
      strokeColor: tone.stroke,
      fillStyle: "solid",
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3 },
      groupIds: [g],
    },
  ];
  let cy = y + 12;
  if (title) {
    const h = titleH + BOUND_PAD * 2;
    els.push(textBox(x + 12, cy, inner, h, titleLines.join("\n"), { fontSize: titleSize, color: tone.title, align: "left", groupIds: [g] }));
    cy += h + gap;
  }
  if (body.length) {
    const h = bodyH + BOUND_PAD * 2;
    els.push(textBox(x + 12, cy, inner, h, body.join("\n"), { fontSize: bodySize, color: MUTED, align: "left", valign: "top", mono: o.mono, groupIds: [g] }));
  }
  return { els, box: { x, y, width, height, shape: "rectangle" } };
}

// ---------------------------------------------------------------------------
// Architecture diagrams
// ---------------------------------------------------------------------------

interface DiagramOpts {
  /** Horizontal distance between grid columns, in px (default 330). */
  gridX?: number;
  /** Vertical distance between grid rows, in px (default 170). */
  gridY?: number;
}

interface NodeOpts {
  /** Width in grid units (1 = one default node; below 1 scales the default width). */
  w?: number;
  /** Minimum height in grid units. Height otherwise grows to fit the text. */
  h?: number;
  /** Smaller explanatory lines under the title: technology, what it stores, scale. */
  detail?: string | string[];
  /** Draw in red to call attention to it (a failure, a mismatch, a hot spot). */
  highlight?: boolean;
}

interface EdgeOpts {
  /** Dashed orange line — use for async / eventual flows. */
  async?: boolean;
  /** Arrowheads on both ends. */
  both?: boolean;
  /** No arrowheads — a plain association. */
  none?: boolean;
  color?: string;
  /** Waypoints in grid units (the centre of cell col,row), to route around other boxes. */
  via?: [number, number][];
}

interface TableOpts {
  /** Width in pixels; defaults to fit the longest row. */
  width?: number;
  kind?: NodeKind;
}

const NODE_W = 210;
const NODE_H = 80;

export class Diagram {
  private zones: Skeleton[] = [];
  private shapes: Skeleton[] = [];
  private edges: Skeleton[] = [];
  private texts: Skeleton[] = [];
  private boxes = new Map<string, Box>();
  private extents: Box[] = [];
  private pendingZones: { label: string; ids: string[]; color: string }[] = [];
  private readonly gx: number;
  private readonly gy: number;
  /** Group ids must be deterministic: saved edits are keyed by a hash of the output. */
  private groups = 0;

  constructor(
    private readonly title?: string,
    private readonly subtitle?: string,
    opts: DiagramOpts = {},
  ) {
    this.gx = opts.gridX ?? 330;
    this.gy = opts.gridY ?? 170;
  }

  private register(id: string | undefined, box: Box) {
    if (id !== undefined) {
      if (this.boxes.has(id)) throw new Error(`Duplicate node id "${id}"`);
      this.boxes.set(id, box);
    }
    this.extents.push(box);
  }

  private group(prefix: string): string {
    return `${prefix}-g${++this.groups}`;
  }

  /** Centre of grid cell (col, row), in px. */
  private cell(col: number, row: number): Point {
    return { x: col * this.gx + NODE_W / 2, y: row * this.gy + NODE_H / 2 };
  }

  /**
   * Add a component box. `col`/`row` are grid coordinates; the box is vertically
   * centred on its row so arrows between boxes on one row stay horizontal.
   */
  node(id: string, label: string, col: number, row: number, kind: NodeKind = "service", opts: NodeOpts = {}): this {
    const style = STYLES[kind];
    const w = opts.w ?? 1;
    const width = w >= 1 ? NODE_W + (w - 1) * this.gx : NODE_W * w;
    const ellipse = style.shape === "ellipse";
    // Area available for text inside the shape (an ellipse fits a rectangle 1/√2 of its size).
    const k = ellipse ? Math.SQRT1_2 : 1;
    const innerW = width * k - 16;
    const detail = opts.detail === undefined ? [] : Array.isArray(opts.detail) ? opts.detail : [opts.detail];

    const titleLines = wrap(label, innerW - 2 * BOUND_PAD, 16);
    const detailLines = detail.flatMap((d) => wrap(d, innerW - 2 * BOUND_PAD, 13));
    const titleH = titleLines.length * 16 * SANS_LINE + BOUND_PAD * 2;
    const detailH = detailLines.length ? detailLines.length * 13 * SANS_LINE + BOUND_PAD * 2 : 0;
    const contentH = titleH + detailH;
    const minH = NODE_H + ((opts.h ?? 1) - 1) * this.gy;
    const height = Math.max(minH, Math.ceil((contentH + 14) / k));

    const x = col * this.gx;
    const y = row * this.gy + NODE_H / 2 - height / 2;
    const box: Box = { x, y, width, height, shape: style.shape };
    this.register(id, box);

    const base = {
      type: style.shape,
      id,
      x,
      y,
      width,
      height,
      backgroundColor: opts.highlight ? "#ffe3e3" : style.backgroundColor,
      strokeColor: opts.highlight ? "#e03131" : style.strokeColor,
      strokeStyle: style.strokeStyle ?? "solid",
      fillStyle: "solid",
      strokeWidth: opts.highlight ? 3 : 2,
      roughness: 1,
      roundness: ellipse ? null : ({ type: 3 } as const),
    } as const;

    if (!detailLines.length) {
      this.shapes.push({ ...base, label: { text: titleLines.join("\n"), fontFamily: DIAGRAM_FONT.id, fontSize: 16, strokeColor: TEXT } });
      return this;
    }

    // Title and detail are separate text boxes grouped with the shape, so they
    // can use different sizes and colours and still move as one.
    const g = this.group(id);
    const top = y + height / 2 - contentH / 2;
    const tx = x + width / 2 - innerW / 2;
    this.shapes.push(
      { ...base, groupIds: [g] },
      textBox(tx, top, innerW, titleH, titleLines.join("\n"), { fontSize: 16, color: TEXT, groupIds: [g] }),
      textBox(tx, top + titleH, innerW, detailH, detailLines.join("\n"), { fontSize: 13, color: MUTED, groupIds: [g] }),
    );
    return this;
  }

  /** A database table / record schema. Rows are monospace, so pad with spaces to line up columns. */
  table(id: string, name: string, rows: string[], col: number, row: number, opts: TableOpts = {}): this {
    const style = STYLES[opts.kind ?? "db"];
    const longest = Math.max(textWidth(name, 15), ...rows.map((r) => textWidth(r, 13, true)));
    const width = opts.width ?? Math.ceil(longest + 34);
    const headH = 34;
    const bodyH = Math.ceil(rows.length * 13 * MONO_LINE + BOUND_PAD * 2 + 14);
    const x = col * this.gx;
    const y = row * this.gy;
    const g = this.group(id);
    this.shapes.push(
      {
        type: "rectangle",
        id,
        x,
        y,
        width,
        height: headH,
        backgroundColor: style.backgroundColor,
        strokeColor: style.strokeColor,
        fillStyle: "solid",
        strokeWidth: 2,
        roughness: 0,
        groupIds: [g],
        label: { text: name, fontFamily: DIAGRAM_FONT.id, fontSize: 15, strokeColor: TEXT },
      },
      {
        type: "rectangle",
        x,
        y: y + headH,
        width,
        height: bodyH,
        backgroundColor: "#ffffff",
        strokeColor: style.strokeColor,
        fillStyle: "solid",
        strokeWidth: 2,
        roughness: 0,
        groupIds: [g],
      },
      textBox(x + 10, y + headH + 7, width - 20, bodyH - 14, rows.join("\n"), {
        fontSize: 13,
        color: "#343a40",
        align: "left",
        valign: "top",
        mono: true,
        groupIds: [g],
      }),
    );
    // Arrows attach to the header, but route as if the table were one box.
    this.register(id, { x, y, width, height: headH + bodyH, shape: "rectangle" });
    return this;
  }

  /** A note / callout box, anchored at the top-left of grid cell (col, row). */
  panel(title: string | undefined, lines: string[], col: number, row: number, opts: PanelOpts = {}): this {
    const { els, box } = panel(this.group("panel"), title, lines, col * this.gx, row * this.gy, opts);
    this.texts.push(...els);
    this.extents.push(box);
    return this;
  }

  /** Numbered step list, useful for describing a request flow beside the diagram. */
  steps(title: string, steps: string[], col: number, row: number, opts: Omit<PanelOpts, "numbered"> = {}): this {
    return this.panel(title, steps, col, row, { tone: "info", width: 340, ...opts, numbered: true });
  }

  /** Connect two nodes with a bound arrow. */
  edge(from: string, to: string, label?: string, opts: EdgeOpts = {}): this {
    const a = this.boxes.get(from);
    const b = this.boxes.get(to);
    if (!a || !b) throw new Error(`Edge ${from} -> ${to} references an unknown node`);
    const via = (opts.via ?? []).map(([c, r]) => this.cell(c, r));
    // Waypoints can sit outside every box; keep the heading clear of them.
    for (const p of via) this.extents.push({ x: p.x, y: p.y - 20, width: 0, height: 0, shape: "rectangle" });
    this.edges.push({
      type: "arrow",
      ...linear(route(a, b, via)),
      start: { id: from },
      end: { id: to },
      strokeColor: opts.color ?? (opts.async ? "#e8590c" : "#495057"),
      strokeStyle: opts.async ? "dashed" : "solid",
      strokeWidth: 2,
      roughness: 1,
      startArrowhead: opts.both ? "arrow" : null,
      endArrowhead: opts.none ? null : "arrow",
      label: label ? { text: label, fontFamily: DIAGRAM_FONT.id, fontSize: 14, strokeColor: "#343a40" } : undefined,
    });
    return this;
  }

  /** A labelled dashed boundary drawn behind the given nodes (e.g. "Data tier", "Region A"). */
  zone(label: string, ids: string[], color = "#adb5bd"): this {
    this.pendingZones.push({ label, ids, color });
    return this;
  }

  /** A plain circle centred on cell (col, row), e.g. a consistent-hashing ring. */
  circle(col: number, row: number, radius: number, color = "#adb5bd"): this {
    const c = this.cell(col, row);
    this.zones.push({
      type: "ellipse",
      x: c.x - radius,
      y: c.y - radius,
      width: radius * 2,
      height: radius * 2,
      strokeColor: color,
      backgroundColor: "transparent",
      strokeWidth: 2,
      roughness: 0,
    });
    this.extents.push({ x: c.x - radius, y: c.y - radius, width: radius * 2, height: radius * 2, shape: "ellipse" });
    return this;
  }

  /** Grid position that centres a default-size node on that circle, `angle` degrees clockwise from 12 o'clock. */
  onCircle(col: number, row: number, radius: number, angle: number): [number, number] {
    const c = this.cell(col, row);
    const t = (angle * Math.PI) / 180;
    return [(c.x + radius * Math.sin(t) - NODE_W / 2) / this.gx, (c.y - radius * Math.cos(t) - NODE_H / 2) / this.gy];
  }

  /** Free-floating annotation. */
  note(text: string, col: number, row: number, color = FAINT): this {
    this.texts.push(freeText(col * this.gx, row * this.gy, text, 14, color));
    this.extents.push({ x: col * this.gx, y: row * this.gy, width: 0, height: 0, shape: "rectangle" });
    return this;
  }

  build(): Skeleton[] {
    for (const z of this.pendingZones) {
      const boxes = z.ids.map((id) => {
        const b = this.boxes.get(id);
        if (!b) throw new Error(`Zone "${z.label}" references unknown node "${id}"`);
        return b;
      });
      const pad = 26;
      const x = Math.min(...boxes.map((b) => b.x)) - pad;
      const y = Math.min(...boxes.map((b) => b.y)) - pad - 20;
      const width = Math.max(...boxes.map((b) => b.x + b.width)) + pad - x;
      const height = Math.max(...boxes.map((b) => b.y + b.height)) + pad - y;
      this.zones.push({
        type: "rectangle",
        x,
        y,
        width,
        height,
        strokeColor: z.color,
        backgroundColor: "transparent",
        strokeStyle: "dashed",
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      });
      this.texts.push(freeText(x + 12, y + 6, z.label, 14, z.color));
      this.extents.push({ x, y, width, height, shape: "rectangle" });
    }
    this.pendingZones = [];

    // Place the heading above whatever sits highest.
    const top = Math.min(0, ...this.extents.map((b) => b.y)) - 40;
    const left = Math.min(0, ...this.extents.map((b) => b.x));
    const heading: Skeleton[] = [];
    if (this.title) heading.push(freeText(left, top - (this.subtitle ? 100 : 56), this.title, 34, TEXT));
    if (this.subtitle) heading.push(freeText(left, top - 50, this.subtitle, 18, FAINT));
    // Order matters for z-index: zones at the back, labels on top.
    return [...this.zones, ...this.shapes, ...this.edges, ...this.texts, ...heading];
  }
}

// ---------------------------------------------------------------------------
// Sequence diagrams
// ---------------------------------------------------------------------------

interface SequenceOpts {
  /** Distance between lifelines, in px (default 250). */
  gap?: number;
}

interface MsgOpts {
  /** Dashed orange arrow — fire-and-forget / event. */
  async?: boolean;
  /** Dashed grey arrow — a response to an earlier message. */
  reply?: boolean;
  /** Draw in red — an error path. */
  error?: boolean;
}

type BlockKind = "alt" | "opt" | "loop" | "par" | "critical" | "break";

interface OpenBlock {
  kind: BlockKind;
  label: string;
  y0: number;
  depth: number;
  from?: string;
  to?: string;
  elses: { y: number; label: string }[];
}

interface Actor {
  id: string;
  label: string;
  kind: NodeKind;
  x: number; // lifeline x
}

const ACTOR_W = 190;
const ACTOR_H = 64;
const MSG_SIZE = 14;

export class Sequence {
  private actors: Actor[] = [];
  private byId = new Map<string, Actor>();
  private back: Skeleton[] = [];
  private front: Skeleton[] = [];
  private blocks: OpenBlock[] = [];
  private y = ACTOR_H + 36;
  private n = 0;
  private notes = 0;
  private readonly gap: number;

  constructor(
    private readonly title?: string,
    private readonly subtitle?: string,
    opts: SequenceOpts = {},
  ) {
    this.gap = opts.gap ?? 250;
  }

  /** Declare a participant. Participants are laid out left to right in declaration order. */
  actor(id: string, label: string, kind: NodeKind = "service", opts: { extraGap?: number } = {}): this {
    if (this.byId.has(id)) throw new Error(`Duplicate actor "${id}"`);
    const prev = this.actors[this.actors.length - 1];
    const x = prev ? prev.x + this.gap + (opts.extraGap ?? 0) : ACTOR_W / 2;
    const a = { id, label, kind, x };
    this.actors.push(a);
    this.byId.set(id, a);
    return this;
  }

  private get(id: string): Actor {
    const a = this.byId.get(id);
    if (!a) throw new Error(`Unknown actor "${id}"`);
    return a;
  }

  /** A message between two participants (or to itself). Messages are numbered automatically. */
  msg(from: string, to: string, text: string, opts: MsgOpts = {}): this {
    const a = this.get(from);
    const b = this.get(to);
    const label = `${++this.n}. ${text}`;
    const color = opts.error ? "#e03131" : opts.async ? "#e8590c" : opts.reply ? FAINT : "#343a40";
    const dashed = opts.async || opts.reply;

    if (a === b) {
      const lines = wrap(label, Math.max(this.gap - 70, 260), MSG_SIZE);
      const labelH = lines.length * MSG_SIZE * SANS_LINE;
      const top = this.y;
      this.front.push(freeText(a.x + 52, top, lines.join("\n"), MSG_SIZE, color));
      const loopH = Math.max(26, labelH - 4);
      this.front.push({
        type: "arrow",
        ...linear([
          { x: a.x + 4, y: top + 4 },
          { x: a.x + 42, y: top + 4 },
          { x: a.x + 42, y: top + 4 + loopH },
          { x: a.x + 6, y: top + 4 + loopH },
        ]),
        strokeColor: color,
        strokeStyle: dashed ? "dashed" : "solid",
        strokeWidth: 2,
        roughness: 0,
        endArrowhead: "arrow",
      });
      this.y = top + Math.max(labelH, loopH + 8) + 18;
      return this;
    }

    const span = Math.abs(b.x - a.x);
    const lines = wrap(label, Math.max(span - 24, 300), MSG_SIZE);
    const labelH = lines.length * MSG_SIZE * SANS_LINE;
    const left = Math.min(a.x, b.x);
    const top = this.y;
    const arrowY = top + labelH + 6;
    this.front.push(freeText(left + 12, top, lines.join("\n"), MSG_SIZE, color));
    const dir = Math.sign(b.x - a.x);
    this.front.push({
      type: "arrow",
      ...linear([
        { x: a.x + dir * 3, y: arrowY },
        { x: b.x - dir * 3, y: arrowY },
      ]),
      strokeColor: color,
      strokeStyle: dashed ? "dashed" : "solid",
      strokeWidth: opts.reply ? 1 : 2,
      roughness: 0,
      endArrowhead: opts.async ? "triangle" : "arrow",
    });
    this.y = arrowY + 22;
    return this;
  }

  /** A sticky note spanning one participant or the range between two. */
  note(text: string, over: string | [string, string], tone: Tone = "warn"): this {
    const [a, b] = typeof over === "string" ? [this.get(over), this.get(over)] : [this.get(over[0]), this.get(over[1])];
    const left = Math.min(a.x, b.x) - (a === b ? 115 : 90);
    const right = Math.max(a.x, b.x) + (a === b ? 115 : 90);
    const { els, box } = panel(`note-g${++this.notes}`, undefined, [text], left, this.y, { width: right - left, tone });
    this.front.push(...els);
    this.y = box.y + box.height + 18;
    return this;
  }

  /** A horizontal divider that names the next phase of the flow. */
  phase(text: string): this {
    const left = this.actors[0].x - 120;
    const right = this.actors[this.actors.length - 1].x + 120;
    this.y += 6;
    this.front.push(freeText(left, this.y, text, 16, "#6741d9"));
    this.back.push({
      type: "line",
      ...linear([
        { x: left, y: this.y + 26 },
        { x: right, y: this.y + 26 },
      ]),
      strokeColor: "#b197fc",
      strokeStyle: "dotted",
      strokeWidth: 1,
      roughness: 0,
    });
    this.y += 44;
    return this;
  }

  private open(kind: BlockKind, label: string, from?: string, to?: string): this {
    this.y += 6;
    this.blocks.push({ kind, label, y0: this.y, depth: this.blocks.length, from, to, elses: [] });
    this.y += 34;
    return this;
  }

  /** Alternative paths; follow with `.else(...)` and close with `.end()`. `from`/`to` limit the frame's width. */
  alt(label: string, from?: string, to?: string): this {
    return this.open("alt", label, from, to);
  }

  opt(label: string, from?: string, to?: string): this {
    return this.open("opt", label, from, to);
  }

  loop(label: string, from?: string, to?: string): this {
    return this.open("loop", label, from, to);
  }

  par(label: string, from?: string, to?: string): this {
    return this.open("par", label, from, to);
  }

  critical(label: string, from?: string, to?: string): this {
    return this.open("critical", label, from, to);
  }

  /** Early exit — the rest of the flow is skipped when this block runs. */
  break(label: string, from?: string, to?: string): this {
    return this.open("break", label, from, to);
  }

  else(label: string): this {
    const b = this.blocks[this.blocks.length - 1];
    if (!b) throw new Error("else() without an open block");
    this.y += 4;
    b.elses.push({ y: this.y, label });
    this.y += 34;
    return this;
  }

  end(): this {
    const b = this.blocks.pop();
    if (!b) throw new Error("end() without an open block");
    const xs = (b.from && b.to ? [this.get(b.from), this.get(b.to)] : this.actors).map((a) => a.x);
    const inset = b.depth * 16;
    const left = Math.min(...xs) - 110 + inset;
    const right = Math.max(...xs) + 110 - inset;
    const bottom = this.y + 4;
    const color = b.kind === "break" ? "#e03131" : b.kind === "critical" ? "#c2255c" : "#5c7cfa";
    this.back.push({
      type: "rectangle",
      x: left,
      y: b.y0,
      width: right - left,
      height: bottom - b.y0,
      strokeColor: color,
      backgroundColor: "transparent",
      strokeWidth: 1,
      roughness: 0,
      roundness: null,
    });
    this.front.push(freeText(left + 10, b.y0 + 7, `${b.kind.toUpperCase()}  [${b.label}]`, 14, color));
    for (const e of b.elses) {
      this.back.push({
        type: "line",
        ...linear([
          { x: left, y: e.y },
          { x: right, y: e.y },
        ]),
        strokeColor: color,
        strokeStyle: "dashed",
        strokeWidth: 1,
        roughness: 0,
      });
      this.front.push(freeText(left + 10, e.y + 7, `[${e.label}]`, 14, color));
    }
    this.y = bottom + 16;
    return this;
  }

  build(): Skeleton[] {
    if (this.blocks.length) throw new Error(`Unclosed ${this.blocks[this.blocks.length - 1].kind} block`);
    const endY = this.y + 20;
    const heads: Skeleton[] = [];
    for (const a of this.actors) {
      const style = STYLES[a.kind];
      heads.push({
        type: "rectangle",
        x: a.x - ACTOR_W / 2,
        y: 0,
        width: ACTOR_W,
        height: ACTOR_H,
        backgroundColor: style.backgroundColor,
        strokeColor: style.strokeColor,
        strokeStyle: style.strokeStyle ?? "solid",
        fillStyle: "solid",
        strokeWidth: 2,
        roughness: 1,
        roundness: { type: 3 },
        label: { text: a.label, fontFamily: DIAGRAM_FONT.id, fontSize: 16, strokeColor: TEXT },
      });
      this.back.push({
        type: "line",
        ...linear([
          { x: a.x, y: ACTOR_H },
          { x: a.x, y: endY },
        ]),
        strokeColor: "#adb5bd",
        strokeStyle: "dashed",
        strokeWidth: 1,
        roughness: 0,
      });
    }
    const left = this.actors[0].x - 120;
    const heading: Skeleton[] = [];
    if (this.title) heading.push(freeText(left, this.subtitle ? -110 : -66, this.title, 34, TEXT));
    if (this.subtitle) heading.push(freeText(left, -60, this.subtitle, 18, FAINT));
    return [...this.back, ...heads, ...this.front, ...heading];
  }
}
