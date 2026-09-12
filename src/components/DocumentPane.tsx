/**
 * The contract as written, with the evidence for the selected field marked.
 *
 * The text is rendered from `segments()` as React elements. Nothing is passed to
 * `dangerouslySetInnerHTML` and no HTML is built from the document or from the model's
 * quotation, which is not a theoretical concern in a tool whose input is a document
 * somebody sent you and whose output is read by somebody deciding to trust it.
 *
 * The scroll is the reason this is a component and not a `<pre>`. A reviewer looking at
 * 損害賠償額の上限 needs 第9条 in front of them, and a contract is several screens long, so
 * selecting a field moves the pane. `scrollIntoView({ block: 'center' })` rather than
 * the default `'start'`: a clause pinned to the top edge with its heading just above the
 * fold reads as a different clause.
 */

import { useEffect, useMemo, useRef } from 'react';

import { type Segment, segments } from '../highlight';
import type { ExtractedField, ExtractionDocument } from '../types';

interface Props {
  document: ExtractionDocument;
  selected: ExtractedField | null;
}

export function DocumentPane({ document: doc, selected }: Props) {
  const activeRef = useRef<HTMLElement | null>(null);

  const parts = useMemo<Segment[]>(() => {
    const others = doc.fields
      .filter((f) => f !== selected && f.span !== null)
      .map((f) => f.span!);
    return segments(doc.text, selected?.span ?? null, others);
  }, [doc, selected]);

  useEffect(() => {
    // Keyed on the span rather than on the field, so re-selecting a field whose evidence
    // is already centred does not scroll, while two fields quoting the same clause do not
    // scroll twice either.
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selected?.span?.start, selected?.span?.end]);

  return (
    <article className="document" aria-label={doc.title}>
      <pre className="document-text">
        {parts.map((part) =>
          part.kind === 'plain' ? (
            <span key={part.start}>{part.text}</span>
          ) : (
            <mark
              key={part.start}
              className={`mark mark-${part.kind}`}
              ref={part.kind === 'active' ? activeRef : undefined}
              data-testid={part.kind === 'active' ? 'active-mark' : undefined}
            >
              {part.text}
            </mark>
          ),
        )}
      </pre>
    </article>
  );
}
