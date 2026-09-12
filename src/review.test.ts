import { beforeEach, describe, expect, it } from 'vitest';

import {
  type Decisions,
  keyOf,
  reduce,
  restore,
  save,
  summarise,
  toExport,
  unverifiable,
} from './review';
import { bundle, document, field } from './test/fixtures';

const KEY = keyOf('sample', 'payment_due');

function decide(...actions: Parameters<typeof reduce>[1][]): Decisions {
  return actions.reduce<Decisions>((state, action) => reduce(state, action), {});
}

describe('reduce', () => {
  it('records the three verdicts', () => {
    expect(decide({ type: 'accept', key: KEY })[KEY].verdict).toBe('accepted');
    expect(decide({ type: 'reject', key: KEY })[KEY].verdict).toBe('rejected');
    expect(decide({ type: 'correct', key: KEY, value: '翌月20日' })[KEY]).toEqual({
      verdict: 'corrected',
      value: '翌月20日',
    });
  });

  it('treats an emptied correction as a rejection', () => {
    // Otherwise the export carries an agreed value of "", which a consumer cannot tell
    // apart from "the contract does not state this".
    const state = decide({ type: 'correct', key: KEY, value: '   ' });
    expect(state[KEY]).toEqual({ verdict: 'rejected', value: undefined });
  });

  it('drops the corrected value when the field is later accepted', () => {
    const state = decide(
      { type: 'correct', key: KEY, value: '翌月20日' },
      { type: 'accept', key: KEY },
    );
    expect(state[KEY].value).toBeUndefined();
  });

  it('keeps the note across a change of verdict', () => {
    const state = decide(
      { type: 'accept', key: KEY },
      { type: 'note', key: KEY, note: '経理に確認' },
      { type: 'reject', key: KEY },
    );
    expect(state[KEY]).toEqual({ verdict: 'rejected', value: undefined, note: '経理に確認' });
  });

  it('ignores a note on a field with no decision', () => {
    // A note alone must not create a decision, or an annotated-but-undecided field counts
    // as reviewed and the denominator of the override rate quietly grows.
    expect(decide({ type: 'note', key: KEY, note: 'あとで' })).toEqual({});
  });

  it('clears a decision entirely', () => {
    const state = decide({ type: 'accept', key: KEY }, { type: 'clear', key: KEY });
    expect(state[KEY]).toBeUndefined();
  });
});

describe('summarise', () => {
  it('reports no override rate before anything is reviewed', () => {
    // Null, not zero. "0% overridden" out of zero reviews is the most flattering number
    // available and it says nothing at all.
    expect(summarise(bundle(), {}).overrideRate).toBeNull();
  });

  it('counts corrections and rejections as overrides', () => {
    const b = bundle({
      documents: [
        document({
          fields: [
            field({ key: 'a' }),
            field({ key: 'b' }),
            field({ key: 'c' }),
            field({ key: 'd' }),
          ],
        }),
      ],
    });
    const decisions = decide(
      { type: 'accept', key: keyOf('sample', 'a') },
      { type: 'accept', key: keyOf('sample', 'b') },
      { type: 'correct', key: keyOf('sample', 'c'), value: 'x' },
      { type: 'reject', key: keyOf('sample', 'd') },
    );
    const summary = summarise(b, decisions);
    expect(summary).toMatchObject({ reviewed: 4, accepted: 2, corrected: 1, rejected: 1 });
    expect(summary.overrideRate).toBeCloseTo(0.5);
  });

  it('counts a field accepted with an unlocatable quote', () => {
    const b = bundle({
      documents: [document({ fields: [field({ quote: '存在しない条文', span: null })] })],
    });
    expect(summarise(b, decide({ type: 'accept', key: KEY })).acceptedWithoutEvidence).toBe(1);
  });

  it('does not count an absent value as accepted without evidence', () => {
    // A null value has nothing to quote, and treating that as unevidenced would bury the
    // real cases -- which is the same as not counting them.
    const b = bundle({
      documents: [document({ fields: [field({ value: null, quote: null, span: null })] })],
    });
    expect(summarise(b, decide({ type: 'accept', key: KEY })).acceptedWithoutEvidence).toBe(0);
  });
});

describe('unverifiable', () => {
  it('picks out values whose evidence is missing or ambiguous', () => {
    const doc = document({
      fields: [
        field({ key: 'fine' }),
        field({ key: 'unlocatable', quote: '存在しない条文', span: null }),
        field({ key: 'ambiguous', occurrences: 3 }),
        field({ key: 'absent', value: null, quote: null, span: null }),
      ],
    });
    expect(unverifiable(doc).map((f) => f.key)).toEqual(['unlocatable', 'ambiguous']);
  });
});

describe('toExport', () => {
  it('exports the extracted value only where it was accepted', () => {
    const exported = toExport(bundle(), decide({ type: 'accept', key: KEY }));
    expect(exported.fields[0]).toMatchObject({
      verdict: 'accepted',
      agreed: '請求書を受領した月の翌月末日',
    });
  });

  it('exports null for a rejected field rather than the model answer', () => {
    // Otherwise a downstream consumer picks up a value a human explicitly refused, which
    // is worse than not running the extraction at all.
    const exported = toExport(bundle(), decide({ type: 'reject', key: KEY }));
    expect(exported.fields[0]).toMatchObject({ verdict: 'rejected', agreed: null });
  });

  it('exports the reviewer value for a corrected field', () => {
    const exported = toExport(bundle(), decide({ type: 'correct', key: KEY, value: '翌月20日' }));
    expect(exported.fields[0]).toMatchObject({ verdict: 'corrected', agreed: '翌月20日' });
  });

  it('carries the run that produced the values', () => {
    // Which prompt produced a bundle changes how much the accepted values are worth, so it
    // travels with the export instead of living only in the tab it was reviewed in.
    expect(toExport(bundle(), {}).source.run.prompt).toBe('guarded');
  });
});

describe('save and restore', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips decisions', () => {
    const decisions = decide({ type: 'correct', key: KEY, value: '翌月20日' });
    save(decisions);
    expect(restore()).toEqual(decisions);
  });

  it('returns an empty set for corrupt storage instead of throwing', () => {
    // A stored blob from an older key shape must not be able to stop the screen opening.
    localStorage.setItem('clause-check/decisions/v1', '{oops');
    expect(restore()).toEqual({});
  });

  it('returns an empty set when storage holds an array', () => {
    localStorage.setItem('clause-check/decisions/v1', '[]');
    expect(restore()).toEqual({});
  });
});
