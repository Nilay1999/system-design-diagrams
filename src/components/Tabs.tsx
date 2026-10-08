import type { ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
}

interface Props<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Visual style: `segmented` (pill group) or `diagram-tabs` (folder tabs). */
  className: string;
}

/** A row of mutually exclusive buttons, exposed to assistive tech as a tab list. */
export function Tabs<T extends string>({ items, value, onChange, label, className }: Props<T>) {
  return (
    <div className={className} role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={item.id === value}
          className={item.id === value ? "on" : ""}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
