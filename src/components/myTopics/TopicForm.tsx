import { useMemo, useState, type FormEvent } from "react";

import { useBeforeUnload } from "../../hooks/useBeforeUnload";
import {
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  LIMITS,
  formatTags,
  normalizeDraft,
  parseTags,
  validateDraft,
  type DraftErrors,
  type TopicDraft,
} from "../../myTopics/model";
import { Field } from "../Field";
import { MarkdownContent } from "../MarkdownContent";

interface Props {
  initial: TopicDraft;
  submitLabel: string;
  /** Suggestions for the category field. */
  categories: readonly string[];
  /** Resolves when saved; a rejection is shown as a form error. */
  onSubmit: (draft: TopicDraft) => Promise<unknown>;
  onCancel: () => void;
}

/** Create or edit a topic's details and problem statement, with a live Markdown preview. */
export function TopicForm({ initial, submitLabel, categories, onSubmit, onCancel }: Props) {
  const [draft, setDraft] = useState(initial);
  // Tags are edited as free text and parsed on submit, so typing a comma doesn't fight the cursor.
  const [tagsText, setTagsText] = useState(() => formatTags(initial.tags));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const current = useMemo(() => ({ ...draft, tags: parseTags(tagsText) }), [draft, tagsText]);
  const dirty = useMemo(
    () => JSON.stringify(normalizeDraft(current)) !== JSON.stringify(normalizeDraft(initial)),
    [current, initial],
  );
  useBeforeUnload(dirty && !saving);

  // Editing a field clears its error; the rest stay until the next submit.
  const clearError = (key: keyof TopicDraft) =>
    setErrors((e) => {
      if (!(key in e)) return e;
      const { [key]: _, ...rest } = e;
      return rest;
    });
  const set = <K extends keyof TopicDraft>(key: K, value: TopicDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    clearError(key);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeDraft(current);
    const found = validateDraft(normalized);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSubmit(normalized);
    } catch {
      setSaveError("The topic couldn't be saved in this browser. Storage may be full or blocked.");
      setSaving(false);
    }
  };

  const listId = "topic-categories";

  return (
    <form className="topic-form" onSubmit={submit} noValidate>
      <div className="form-fields">
        <Field label="Title" error={errors.title}>
          <input value={draft.title} maxLength={LIMITS.title} onChange={(e) => set("title", e.target.value)} autoFocus required />
        </Field>
        <Field label="Summary" hint="One sentence, shown under the title." error={errors.summary}>
          <input value={draft.summary} maxLength={LIMITS.summary} onChange={(e) => set("summary", e.target.value)} />
        </Field>
        <div className="field-row">
          <Field label="Category" hint="Groups topics in the sidebar." error={errors.category}>
            <input
              value={draft.category}
              maxLength={LIMITS.category}
              list={listId}
              placeholder="My Topics"
              onChange={(e) => set("category", e.target.value)}
            />
          </Field>
          <Field label="Difficulty" error={errors.difficulty}>
            <select value={draft.difficulty} onChange={(e) => set("difficulty", e.target.value as TopicDraft["difficulty"])}>
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_LABELS[d]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <datalist id={listId}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <Field label="Tags" hint="Comma-separated, e.g. caching, sharding." error={errors.tags}>
          <input
            value={tagsText}
            onChange={(e) => {
              setTagsText(e.target.value);
              clearError("tags");
            }}
          />
        </Field>
        <Field label="Problem statement" hint="Markdown. Each ## heading appears in the page index." error={errors.statement}>
          <textarea
            className="statement-input"
            value={draft.statement}
            maxLength={LIMITS.statement}
            onChange={(e) => set("statement", e.target.value)}
            spellCheck
          />
        </Field>
        {saveError && (
          <p className="form-error" role="alert">
            {saveError}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? "Saving…" : submitLabel}
          </button>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      <section className="form-preview" aria-label="Preview">
        <h2 className="preview-label">Preview</h2>
        <h1 className="preview-title">{draft.title || "Untitled topic"}</h1>
        {draft.summary && <p className="preview-summary">{draft.summary}</p>}
        <MarkdownContent>{draft.statement}</MarkdownContent>
      </section>
    </form>
  );
}
