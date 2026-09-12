import { describe, expect, it } from 'vitest';

import { segments } from './highlight';

const TEXT = '0123456789';

function kinds(text: string, active: { start: number; end: number } | null, others: Array<{ start: number; end: number }> = []) {
  return segments(text, active, others).map((s) => `${s.kind}:${s.text}`);
}

describe('segments', () => {
  it('covers the text exactly, with no character lost or repeated', () => {
    // The property that matters more than any individual case: this output is the document
    // the reviewer reads, so a dropped segment silently deletes a clause from a contract.
    const parts = segments(TEXT, { start: 3, end: 5 }, [{ start: 7, end: 9 }]);
    expect(parts.map((p) => p.text).join('')).toBe(TEXT);
  });

  it('marks the active span and leaves the rest plain', () => {
    expect(kinds(TEXT, { start: 3, end: 5 })).toEqual(['plain:012', 'active:34', 'plain:56789']);
  });

  it('marks other fields quotes faintly', () => {
    expect(kinds(TEXT, null, [{ start: 0, end: 2 }])).toEqual(['other:01', 'plain:23456789']);
  });

  it('sorts spans given out of order', () => {
    expect(kinds(TEXT, null, [{ start: 6, end: 8 }, { start: 1, end: 3 }])).toEqual([
      'plain:0',
      'other:12',
      'plain:345',
      'other:67',
      'plain:89',
    ]);
  });

  it('merges two overlapping background spans instead of nesting them', () => {
    expect(kinds(TEXT, null, [{ start: 1, end: 5 }, { start: 3, end: 7 }])).toEqual([
      'plain:0',
      'other:123456',
      'plain:789',
    ]);
  });

  it('clips a background span around the active one, keeping both remainders', () => {
    // Dropping the overlapping span entirely would erase the marks on the parts of that
    // quote which do not overlap, reading as a passage the extraction never touched.
    expect(kinds(TEXT, { start: 4, end: 6 }, [{ start: 2, end: 8 }])).toEqual([
      'plain:01',
      'other:23',
      'active:45',
      'other:67',
      'plain:89',
    ]);
  });

  it('ignores an out-of-bounds or inverted span rather than throwing', () => {
    // These arrive from a producer in another language and another repository. Refusing to
    // render the contract because one offset is wrong is a worse outcome than rendering it
    // without one mark.
    expect(kinds(TEXT, { start: 8, end: 99 })).toEqual(['plain:0123456789']);
    expect(kinds(TEXT, { start: 5, end: 5 })).toEqual(['plain:0123456789']);
    expect(kinds(TEXT, null, [{ start: 6, end: 2 }])).toEqual(['plain:0123456789']);
  });

  it('carries the source offset so identical passages get distinct keys', () => {
    // 「甲の負担とする。」 appears twice in real contracts, and two React children keyed by
    // their text would collide.
    const parts = segments('aXaX', null, [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
    const starts = parts.filter((p) => p.kind === 'other').map((p) => p.start);
    expect(starts).toEqual([0, 2]);
  });

  it('returns a single plain segment when nothing is marked', () => {
    expect(kinds(TEXT, null, [])).toEqual(['plain:0123456789']);
  });
});
