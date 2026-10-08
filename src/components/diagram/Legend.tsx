import { LEGEND, kindColor } from "../../diagrams/dsl";

const LINES = [
  { className: "line", label: "sync call" },
  { className: "line line-async", label: "async / event" },
  { className: "line line-reply", label: "response" },
];

/** Key to the node colours and arrow styles used by DSL diagrams. */
export function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
      {LEGEND.map(({ kind, label }) => {
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
