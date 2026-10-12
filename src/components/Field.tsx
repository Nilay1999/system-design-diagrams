import { useId, type ReactElement, type ReactNode } from "react";
import { cloneElement } from "react";

interface Props {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** A single form control; it gets the id and ARIA attributes that tie it to the label, hint and error. */
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
}

/** Label, control, hint and error for one form field, wired up for assistive tech. */
export function Field({ label, hint, error, children }: Props) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${error ? "has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && (
        <small id={hintId} className="field-hint">
          {hint}
        </small>
      )}
      {error && (
        <small id={errorId} className="field-error">
          {error}
        </small>
      )}
    </div>
  );
}
