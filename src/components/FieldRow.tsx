/**
 * One extracted field: the value, what backs it, and the three things a reviewer can say.
 *
 * The correction box is a React 19 form action -- `<form action={fn}>` with
 * `useActionState` -- rather than `onSubmit` with `preventDefault`. Two reasons beyond
 * being shorter. The action receives `FormData`, so the textarea is uncontrolled and the
 * component holds no draft state that could disagree with what is on screen. And the
 * action's return value is where validation lives, which keeps the "you did not change
 * anything" case out of the reducer: the reducer's job is to record decisions, not to
 * decide whether a decision was meaningful.
 *
 * The value is never rendered as HTML. It arrived from a model reading a document from
 * outside.
 */

import { useActionState, useEffect, useRef } from 'react';

import type { Decision } from '../review';
import type { ExtractedField } from '../types';

interface Props {
  field: ExtractedField;
  decision: Decision | undefined;
  selected: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onReject: () => void;
  onCorrect: (value: string) => void;
  onNote: (note: string) => void;
  editing: boolean;
  onEdit: (editing: boolean) => void;
}

/** Why the evidence for a value may not be usable, or null when it is fine. */
function evidenceProblem(field: ExtractedField): string | null {
  if (field.value === null) return null;
  if (field.quote === null) return '根拠となる原文が示されていません';
  if (field.span === null) return '示された原文がこの文書内に見つかりません';
  if (field.occurrences > 1) return `同じ文が文書内に${field.occurrences}箇所あります`;
  return null;
}

export function FieldRow({
  field,
  decision,
  selected,
  onSelect,
  onAccept,
  onReject,
  onCorrect,
  onNote,
  editing,
  onEdit,
}: Props) {
  const problem = evidenceProblem(field);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const [error, submit] = useActionState<string | null, FormData>((_previous, form) => {
    const next = String(form.get('value') ?? '');
    if (next.trim() === (field.value ?? '').trim()) {
      // Recording this as a correction would make the override count include fields
      // nobody changed, and that count is the one number here that decides whether the
      // extraction is worth running.
      return '値が変わっていません。そのままで良ければ「承認」を押してください。';
    }
    onCorrect(next);
    onEdit(false);
    return null;
  }, null);

  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);

  return (
    <li
      className={`field ${selected ? 'field-selected' : ''} ${
        decision ? `field-${decision.verdict}` : ''
      }`}
    >
      <button type="button" className="field-head" onClick={onSelect} aria-current={selected}>
        <span className="field-label">{field.label}</span>
        {decision && <span className={`verdict verdict-${decision.verdict}`}>{VERDICT[decision.verdict]}</span>}
      </button>

      <p className={field.value === null ? 'value value-absent' : 'value'}>
        {field.value ?? '定めなし（文書に記載がないと判定）'}
      </p>

      {decision?.verdict === 'corrected' && decision.value && (
        <p className="value value-corrected">
          <span className="value-corrected-tag">修正後</span>
          {decision.value}
        </p>
      )}

      {selected && (
        <>
          {field.quote !== null && (
            <blockquote className={field.span === null ? 'quote quote-ungrounded' : 'quote'}>
              {field.quote}
            </blockquote>
          )}

          {problem && <p className="problem">{problem}</p>}

          <p className="question" title="モデルに与えた指示">
            {field.question}
          </p>

          <div className="actions">
            <button type="button" onClick={onAccept}>
              承認 <kbd>a</kbd>
            </button>
            <button type="button" onClick={() => onEdit(!editing)}>
              修正 <kbd>e</kbd>
            </button>
            <button type="button" onClick={onReject}>
              却下 <kbd>r</kbd>
            </button>
          </div>

          {editing && (
            <form action={submit} className="correct">
              <textarea
                ref={textarea}
                name="value"
                rows={3}
                defaultValue={decision?.value ?? field.value ?? ''}
                aria-label={`${field.label}の修正`}
              />
              {error && <p className="error">{error}</p>}
              <div className="actions">
                <button type="submit">保存</button>
                <button type="button" onClick={() => onEdit(false)}>
                  やめる
                </button>
              </div>
            </form>
          )}

          <input
            className="note"
            type="text"
            placeholder="メモ（任意）"
            defaultValue={decision?.note ?? ''}
            onBlur={(event) => onNote(event.target.value)}
            aria-label={`${field.label}のメモ`}
          />
        </>
      )}
    </li>
  );
}

const VERDICT: Record<Decision['verdict'], string> = {
  accepted: '承認',
  corrected: '修正',
  rejected: '却下',
};
