import { describe, expect, it } from 'vitest';

import { store } from './harness';

const s = store();

describe('the shared store', () => {
  it('parses the committed bundles rather than casting them', () => {
    // If the pipeline's output shape drifts, this throws here at startup instead of serving
    // a null where a span should be, with a 200.
    expect(s.bundle('guarded').documents).toHaveLength(4);
    expect(s.bundle('naive').documents).toHaveLength(4);
  });

  it('serves both runs from the same code path', () => {
    // The comparison is only about interfaces if the data underneath is identical in
    // provenance. Two loaders would make every difference ambiguous.
    for (const prompt of ['guarded', 'naive'] as const) {
      expect(s.field(prompt, 'saas-riyo', 'jurisdiction')).toBeDefined();
    }
  });

  it('locates a quotation and reports the span in the raw text', () => {
    const doc = s.document('guarded', 'gyomu-itaku')!;
    const field = doc.fields.find((f) => f.span !== null)!;
    const found = s.verify('guarded', 'gyomu-itaku', field.quote!);
    expect(found.grounded).toBe(true);
    expect(found.span).toEqual(field.span);
    expect(found.passage).toBe(doc.text.slice(field.span!.start, field.span!.end));
  });

  it('agrees with the pipeline about every quotation in the guarded bundle', () => {
    // The double implementation earning its keep: `pipeline/ground.py` produced these spans
    // in Python, and `locate()` re-derives them in TypeScript. Python indexes code points
    // and JavaScript indexes UTF-16 code units, so this equality is only guaranteed while
    // the corpus stays inside the BMP -- which it is, and this test is where that
    // assumption would break loudly if a contract ever gained an emoji.
    for (const doc of s.bundle('guarded').documents) {
      for (const field of doc.fields) {
        if (field.quote === null) continue;
        expect(s.verify('guarded', doc.id, field.quote).span).toEqual(field.span);
      }
    }
  });

  it('agrees with the pipeline about the naive run, including its ungrounded quotation', () => {
    const ungrounded = s
      .bundle('naive')
      .documents.flatMap((doc) => doc.fields.map((field) => ({ doc, field })))
      .filter(({ field }) => field.quote !== null && field.span === null);
    expect(ungrounded).toHaveLength(1);
    for (const { doc, field } of ungrounded) {
      expect(s.verify('naive', doc.id, field.quote!).grounded).toBe(false);
    }
  });

  it('counts repeated passages, because a citation to one is ambiguous', () => {
    const doc = s.document('guarded', 'gyomu-itaku')!;
    // A string this short occurs many times in a contract; the count is what tells a
    // caller the span is one of several rather than the passage.
    const repeated = s.verify('guarded', 'gyomu-itaku', '甲は');
    expect(repeated.occurrences).toBeGreaterThan(1);
    expect(doc.text.slice(repeated.span!.start, repeated.span!.end).replace(/\s/g, '')).toBe('甲は');
  });

  it('ignores whitespace and width differences, and nothing else', () => {
    const doc = s.document('guarded', 'saas-riyo')!;
    const field = doc.fields.find((f) => f.span !== null && f.quote!.length > 12)!;
    const raw = doc.text.slice(field.span!.start, field.span!.end);
    expect(s.verify('guarded', 'saas-riyo', raw.replace(/\s/g, '')).grounded).toBe(true);
    expect(s.verify('guarded', 'saas-riyo', `　${raw}　`).grounded).toBe(true);
    // One character changed is not a match. A search that tolerated this would report
    // fabricated quotations as grounded, which is the failure the repository exists to catch.
    expect(s.verify('guarded', 'saas-riyo', `${raw.slice(0, -1)}X`).grounded).toBe(false);
  });

  it('treats an empty quotation as ungrounded instead of matching everything', () => {
    expect(s.verify('guarded', 'saas-riyo', '　　').grounded).toBe(false);
    expect(s.verify('guarded', 'saas-riyo', '　　').occurrences).toBe(0);
  });

  it('throws for a document it does not have, rather than answering about nothing', () => {
    expect(() => s.verify('guarded', 'no-such-contract', '甲は')).toThrow(/no such document/);
  });
});
