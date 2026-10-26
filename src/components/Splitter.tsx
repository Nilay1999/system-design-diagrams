import type { KeyboardEvent, PointerEvent } from "react";

interface Props {
  /** Width of the pane before the splitter, as a percentage of the parent's width. */
  value: number;
  onChange: (percent: number) => void;
  /** Restored by a double-click. */
  defaultValue: number;
  min: number;
  max: number;
  label: string;
}

const KEY_STEP = 2;

/** A draggable vertical divider between two panes. Also works with the arrow keys. */
export function Splitter({ value, onChange, defaultValue, min, max, label }: Props) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // Keep receiving moves while the pointer is over the diagram canvas.
    e.currentTarget.setPointerCapture(e.pointerId);
    document.documentElement.classList.add("resizing");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    onChange(clamp(((e.clientX - box.left) / box.width) * 100));
  };
  const onPointerUp = () => document.documentElement.classList.remove("resizing");
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") onChange(clamp(value - KEY_STEP));
    else if (e.key === "ArrowRight") onChange(clamp(value + KEY_STEP));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(defaultValue)}
    />
  );
}
