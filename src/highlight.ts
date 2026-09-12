/**
 * Cut a document into the segments the viewer renders.
 *
 * Pure arithmetic over offsets, kept out of the component because the interesting cases
 * are all boundary cases and none of them need a DOM to check: spans arriving out of
 * order, two fields quoting overlapping passages, a quote that begins where another
 * ends. The renderer's job is then a `map`, with no index arithmetic in JSX.
 *
 * Three kinds rather than two. Every located quote is shown faintly, so a reviewer can
 * see at a glance which parts of the contract the extraction drew on at all -- the
 * unmarked remainder is the part no field claims to have read, and in a document review
 * that gap is information. The field being examined is marked distinctly on top of that.
 */

import type { Span } from './types';

export interface Segment {
  text: string;
  kind: 'plain' | 'active' | 'other';
  /** Offset in the source text. Used as the React key, since the same substring can
   *  legitimately appear twice and 「甲の負担とする。」 does. */
  start: number;
}

/** Ordered, non-overlapping, in-bounds. */
function clean(spans: Span[], length: number): Span[] {
  return spans
    .filter((s) => s.start < s.end && s.start >= 0 && s.end <= length)
    .sort((a, b) => a.start - b.start)
    .reduce<Span[]>((kept, span) => {
      const last = kept[kept.length - 1];
      // Overlapping quotes are merged rather than nested. Nesting would need the
      // renderer to handle a mark inside a mark for no gain: both are "some field
      // quoted this".
      if (last && span.start <= last.end) {
        last.end = Math.max(last.end, span.end);
        return kept;
      }
      kept.push({ ...span });
      return kept;
    }, []);
}

/**
 * `text` split into consecutive segments covering it exactly.
 *
 * The active span wins where it overlaps another: the reviewer is looking at one field,
 * and a passage half-marked as active and half as background reads as two passages.
 */
export function segments(text: string, active: Span | null, others: Span[]): Segment[] {
  const inBounds = active && active.start < active.end && active.end <= text.length ? active : null;

  // Background spans are clipped against the active one rather than dropped. Dropping
  // loses the non-overlapping remainder of a long quote, which reads as the extraction
  // not having touched a passage it did quote.
  const background = clean(others, text.length).flatMap<Span>((span) => {
    if (!inBounds || span.end <= inBounds.start || span.start >= inBounds.end) return [span];
    return [
      { start: span.start, end: Math.min(span.end, inBounds.start) },
      { start: Math.max(span.start, inBounds.end), end: span.end },
    ].filter((s) => s.start < s.end);
  });

  const marks: Array<Span & { kind: 'active' | 'other' }> = [
    ...background.map((s) => ({ ...s, kind: 'other' as const })),
    ...(inBounds ? [{ ...inBounds, kind: 'active' as const }] : []),
  ].sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start > at) out.push({ text: text.slice(at, mark.start), kind: 'plain', start: at });
    out.push({ text: text.slice(mark.start, mark.end), kind: mark.kind, start: mark.start });
    at = mark.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: 'plain', start: at });
  return out;
}
