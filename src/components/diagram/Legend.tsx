import { kindColor, type LegendEntry } from "../../diagrams/dsl";

const LINES = [
  { className: "line", label: "sync call" },
  { className: "line line-async", label: "async / event" },
  { className: "line line-reply", label: "response" },
];

/** Key to the node colours and arrow styles used by DSL diagrams. Each track names the colours its own way. */
export function Legend({ entries }: { entries: readonly LegendEntry[] }) {
  return (
    <ul className="legend" aria-label="Legend">
      {entries.map(({ kind, label }) => {
        const c = kindColor(kind);
        return (
          <li key={kind}>
            <span className="swatch" style={{ background: c.bg, borderColor: c.stroke }} />
            {label}
          </li>
        );
      })}
      {LINES.map(({ className, label }) => (
        <li key={label}>
          <span className={className} /> {label}
        </li>
      ))}
    </ul>
  );
}
