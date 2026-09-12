/**
 * The data every interface serves, loaded once.
 *
 * REST, GraphQL and MCP all read from here, on purpose. If each had its own accessor the
 * comparison in the README would be measuring three implementations rather than three
 * interfaces, and the differences that matter -- payload shape, error shape, who the
 * consumer is -- would be buried under incidental ones.
 *
 * The bundles are the committed ones under `public/`, parsed by the same `parseBundle`
 * the browser uses. A server that skipped that check could serve a span pointing at the
 * wrong clause with a 200, which is the failure this whole repository exists to catch.
 */

import { readFileSync } from 'node:fs';

import { parseBundle } from '../src/bundle';
import { normalise } from '../src/normalise';
import type { Bundle, ExtractedField, ExtractionDocument } from '../src/types';

export type Prompt = 'guarded' | 'naive';

const FILES: Record<Prompt, string> = {
  guarded: 'public/extraction.json',
  naive: 'public/extraction-naive.json',
};

export interface Store {
  bundle(prompt: Prompt): Bundle;
  document(prompt: Prompt, id: string): ExtractionDocument | undefined;
  field(prompt: Prompt, id: string, key: string): ExtractedField | undefined;
  /** Both runs' view of one field, which is the comparison the README is built on. */
  compare(id: string, key: string): { guarded?: ExtractedField; naive?: ExtractedField };
  verify(prompt: Prompt, id: string, quote: string): Verification;
}

export interface Verification {
  document: string;
  quote: string;
  grounded: boolean;
  span: { start: number; end: number } | null;
  occurrences: number;
  /** The passage as the document actually writes it -- line breaks, indentation and all.
   *  A caller that only gets `grounded: true` has to trust us; with the raw text it can
   *  check. */
  passage: string | null;
}

/**
 * Locate a quotation, reimplementing the pipeline's search in TypeScript.
 *
 * `pipeline/ground.py` does this at extraction time. Doing it again at request time is
 * what makes `verify_quote` worth exposing at all: the caller supplies a quotation that
 * was never in any bundle -- typically one a model just produced -- and asks whether the
 * contract contains it.
 *
 * The index map is rebuilt per call rather than cached. Four contracts of a few kilobytes
 * each is microseconds, and a cache keyed on document text is a correctness risk (a stale
 * entry returns spans into a document that is no longer what we serve) for no measurable
 * gain. `measure.ts` prints the request timings, so the claim is checkable.
 */
function locate(text: string, quote: string): { span: { start: number; end: number } | null; occurrences: number } {
  const needle = normalise(quote);
  if (needle === '') return { span: null, occurrences: 0 };

  // Per character, matching the pipeline: whole-string NFKC can change length and then
  // no character-level correspondence back to the original exists.
  let haystack = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/[\s　]/u.test(ch)) continue;
    const normalised = ch.normalize('NFKC');
    for (const part of normalised) {
      haystack += part;
      origin.push(i);
    }
  }

  let occurrences = 0;
  let first = -1;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (first === -1) first = at;
    occurrences += 1;
  }
  if (first === -1) return { span: null, occurrences: 0 };

  return {
    span: { start: origin[first], end: origin[first + needle.length - 1] + 1 },
    occurrences,
  };
}

export function openStore(root = process.cwd()): Store {
  const bundles = new Map<Prompt, Bundle>();
  const load = (prompt: Prompt): Bundle => {
    const cached = bundles.get(prompt);
    if (cached) return cached;
    const parsed = parseBundle(JSON.parse(readFileSync(`${root}/${FILES[prompt]}`, 'utf-8')));
    bundles.set(prompt, parsed);
    return parsed;
  };

  const document = (prompt: Prompt, id: string) =>
    load(prompt).documents.find((d) => d.id === id);

  const field = (prompt: Prompt, id: string, key: string) =>
    document(prompt, id)?.fields.find((f) => f.key === key);

  return {
    bundle: load,
    document,
    field,
    compare: (id, key) => ({
      guarded: field('guarded', id, key),
      naive: field('naive', id, key),
    }),
    verify: (prompt, id, quote) => {
      const doc = document(prompt, id);
      if (!doc) throw new Error(`no such document: ${id}`);
      const { span, occurrences } = locate(doc.text, quote);
      return {
        document: id,
        quote,
        grounded: span !== null,
        span,
        occurrences,
        passage: span ? doc.text.slice(span.start, span.end) : null,
      };
    },
  };
}
