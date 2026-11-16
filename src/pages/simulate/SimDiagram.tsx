import { kindColor } from "../../diagrams/dsl";
import { perSecond } from "../../simulations/format";
import { NODE, bounds, edgeLine, nodeRect } from "../../simulations/geometry";
import { edgeId, type EdgeState, type SimEdge, type SimInputs, type SimNode, type Simulation, type Snapshot } from "../../simulations/types";

interface Props {
  sim: Simulation;
  inputs: SimInputs;
  snapshot: Snapshot;
  /** Stop or restart a part. */
  onToggle: (nodeId: string) => void;
}

/** The running system: boxes with live load, and arrows whose moving dots get denser with traffic. */
export function SimDiagram({ sim, inputs, snapshot, onToggle }: Props) {
  const box = bounds(sim);
  return (
    <svg className="sim-diagram" viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} role="group" aria-label="The running system">
      {sim.edges.map((e) => (
        <Edge key={edgeId(e)} sim={sim} edge={e} state={snapshot.edges[edgeId(e)]} />
      ))}
      {sim.nodes.map((n) => (
        <Node key={n.id} node={n} snapshot={snapshot} down={inputs.down.includes(n.id)} onToggle={onToggle} />
      ))}
    </svg>
  );
}

/** Gap between moving dots: busier arrows get denser dots. Stepped, so small changes don't make the dots jump. */
function dotGap(rate: number): number {
  if (rate >= 10_000) return 10;
  if (rate >= 3_000) return 15;
  if (rate >= 500) return 22;
  if (rate >= 50) return 32;
  return 46;
}

function Edge({ sim, edge, state }: { sim: Simulation; edge: SimEdge; state?: EdgeState }) {
  const { from, to } = edgeLine(sim, edge);
  const health = state?.health ?? "idle";
  const rate = state?.rate ?? 0;
  const gap = dotGap(rate);
  const text = [edge.label, state?.text ?? (rate > 0 ? perSecond(rate) : undefined)].filter(Boolean).join(" · ");
  const width = text.length * 6.6 + 12;
  // The label sits just above the middle of the line, so the moving dots stay visible under it.
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 15 };
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  const d = `M${from.x},${from.y} L${to.x},${to.y}`;

  return (
    <g className={`sim-edge sim-edge-${health} ${edge.async ? "sim-edge-async" : ""}`}>
      <path className="sim-wire" d={d} />
      {rate > 0 && <path className="sim-flow" d={d} strokeDasharray={`0.1 ${gap}`} style={{ ["--gap" as string]: `${gap + 0.1}px`, animationDuration: `${gap / 45}s` }} />}
      <path className="sim-arrowhead" d="M0,0 L-9,-5 L-9,5 Z" transform={`translate(${to.x},${to.y}) rotate(${angle})`} />
      {text && (
        <>
          <rect className="sim-edge-plate" x={mid.x - width / 2} y={mid.y - 10} width={width} height={20} rx={4} />
          <text className="sim-edge-text" x={mid.x} y={mid.y + 4} textAnchor="middle">
            {text}
          </text>
        </>
      )}
    </g>
  );
}

function Node({ node, snapshot, down, onToggle }: { node: SimNode; snapshot: Snapshot; down: boolean; onToggle: (id: string) => void }) {
  const r = nodeRect(node);
  const state = snapshot.nodes[node.id];
  const health = state?.health ?? "idle";
  const color = kindColor(node.kind).stroke;
  const barWidth = NODE.width - 28;
  const action = `${down ? "Restart" : "Stop"} ${node.label}`;
  const interactive = node.stoppable
    ? {
        role: "button",
        tabIndex: 0,
        "aria-label": action,
        "aria-pressed": down,
        onClick: () => onToggle(node.id),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(node.id);
          }
        },
      }
    : {};

  return (
    <g className={`sim-node sim-${health} ${node.stoppable ? "sim-stoppable" : ""}`} transform={`translate(${r.x},${r.y})`} {...interactive}>
      {node.stoppable && <title>{action}</title>}
      <rect className="sim-box" width={NODE.width} height={NODE.height} rx={10} />
      {/* A stripe in the colour of the node kind, matching the other diagrams. */}
      <rect className="sim-kind" width={6} height={NODE.height - 20} x={0} y={10} rx={3} style={{ fill: color }} />
      <text className="sim-title" x={NODE.width / 2} y={24} textAnchor="middle">
        {node.label}
      </text>
      <text className="sim-value" x={NODE.width / 2} y={44} textAnchor="middle">
        {state?.value}
      </text>
      {state?.note && (
        <text className="sim-note" x={NODE.width / 2} y={61} textAnchor="middle">
          {state.note}
        </text>
      )}
      {state?.load !== undefined && (
        <>
          <rect className="sim-bar-track" x={14} y={NODE.height - 14} width={barWidth} height={5} rx={2.5} />
          <rect className="sim-bar" x={14} y={NODE.height - 14} width={barWidth * Math.min(1, state.load)} height={5} rx={2.5} />
        </>
      )}
      {node.stoppable && (
        <g className="sim-switch" transform={`translate(${NODE.width - 16},16)`} aria-hidden="true">
          <circle r={9} />
          {/* Power symbol */}
          <path d="M0,-5 V0 M-3.5,-3 A4.6,4.6 0 1 0 3.5,-3" />
        </g>
      )}
    </g>
  );
}
