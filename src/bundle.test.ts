import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BundleError, loadBundle, parseBundle } from './bundle';
import { normalise } from './normalise';
import { bundle, document, field, TEXT } from './test/fixtures';

/** Both committed runs, checked as contracts rather than as fixtures. */
const REAL = ['public/extraction.json', 'public/extraction-naive.json'].map((path) => ({
  path,
  json: JSON.parse(readFileSync(path, 'utf8')) as unknown,
}));

describe('parseBundle', () => {
  it('accepts the fixture', () => {
    expect(parseBundle(bundle()).documents[0].fields[0].value).toBe('請求書を受領した月の翌月末日');
  });

  it('rejects a missing field with the path that is wrong', () => {
    const broken = bundle();
    // @ts-expect-error deleting a required key is the drift being tested for
    delete broken.documents[0].fields[0].occurrences;
    expect(() => parseBundle(broken)).toThrow(/documents\[0\]\.fields\[0\]\.occurrences/);
  });

  it('rejects a span whose text is not the quote it claims', () => {
    // The check that earns its place. An off-by-a-clause span highlights a real sentence
    // from the same contract, so there is nothing on screen to tell the reviewer they are
    // reading the wrong one -- the only place to catch it is at load.
    const wrong = bundle({
      documents: [
        document({
          fields: [field({ span: { start: 0, end: 6 } })],
        }),
      ],
    });
    expect(() => parseBundle(wrong)).toThrow(BundleError);
    expect(() => parseBundle(wrong)).toThrow(/matches the quote/);
  });

  it('rejects a span outside the document', () => {
    const wrong = bundle({
      documents: [document({ fields: [field({ span: { start: 0, end: TEXT.length + 5 } })] })],
    });
    expect(() => parseBundle(wrong)).toThrow(/a range inside 0\.\./);
  });

  it('rejects a span with no quote behind it', () => {
    const wrong = bundle({
      documents: [document({ fields: [field({ quote: null })] })],
    });
    expect(() => parseBundle(wrong)).toThrow(/because a span was given/);
  });

  it('accepts a value whose quote could not be located', () => {
    // Not an error: this is how the pipeline reports a quotation it could not find in the
    // document, and that field is the one most worth showing.
    const parsed = parseBundle(
      bundle({
        documents: [document({ fields: [field({ quote: '存在しない条文', span: null })] })],
      }),
    );
    expect(parsed.documents[0].fields[0].span).toBeNull();
  });

  it('rejects duplicate field keys', () => {
    const dupes = bundle({ documents: [document({ fields: [field(), field()] })] });
    expect(() => parseBundle(dupes)).toThrow(/unique field keys/);
  });
});

describe('loadBundle', () => {
  it('reports the status code rather than a parse error', async () => {
    const fetcher = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(loadBundle('/extraction.json', fetcher)).rejects.toThrow(/HTTP 404/);
  });
});

describe('the committed runs', () => {
  for (const { path, json } of REAL) {
    it(`parses ${path}`, () => {
      expect(() => parseBundle(json)).not.toThrow();
    });

    it(`${path}: every span really is its quote`, () => {
      // Independent of the parser: this recomputes the producer's own claim with this
      // repository's normalisation, so agreement means two implementations in two
      // languages agree about where a passage is, not that one of them is self-consistent.
      const parsed = parseBundle(json);
      for (const doc of parsed.documents) {
        for (const entry of doc.fields) {
          if (!entry.span) continue;
          expect(normalise(doc.text.slice(entry.span.start, entry.span.end))).toBe(
            normalise(entry.quote!),
          );
        }
      }
    });

    it(`${path}: the run's ungrounded count matches the fields`, () => {
      const parsed = parseBundle(json);
      const counted = parsed.documents.flatMap((d) =>
        d.fields.filter((f) => f.quote !== null && f.span === null),
      ).length;
      expect(counted).toBe(parsed.run.ungrounded_quotes);
    });
  }

  it('the naive run is the one carrying an unlocatable quote', () => {
    // Pinned because it is the finding, not an accident of a run: without the instruction
    // to quote verbatim, the model spliced 第6条 1項 and 2項 into one continuous sentence
    // that appears nowhere in the contract.
    const guarded = parseBundle(REAL[0].json);
    const naive = parseBundle(REAL[1].json);
    expect(guarded.run.ungrounded_quotes).toBe(0);
    expect(naive.run.ungrounded_quotes).toBeGreaterThan(0);
  });
});
