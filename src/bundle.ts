/**
 * Parse `extraction.json` into `Bundle`, or throw saying exactly where it stopped.
 *
 * `JSON.parse(...) as Bundle` is one line and it is wrong here. The producer is a Python
 * pipeline on its own release cadence, so field drift is a normal event, and the failure
 * it causes is silent: a renamed key arrives as `undefined`, React renders an empty
 * string, and a reviewer signs off on a clause whose evidence never displayed.
 *
 * Beyond field types, one semantic check earns its place. A span is only useful if it
 * points at the passage the value came from, so the parser slices the document and
 * compares it with the quote under `normalise`. A span that is merely *in range* is not
 * enough: an off-by-a-clause span highlights a real sentence, from the same contract, in
 * the same register, and there is nothing on screen to suggest the reviewer is reading
 * the wrong one. That is the single defect here most likely to change a decision, so it
 * is a load failure rather than a rendering quirk.
 */

import { normalise } from './normalise';
import type { Bundle, ExtractedField, ExtractionDocument, Run, Span } from './types';

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

function fail(path: string, expected: string, got: unknown): never {
  throw new BundleError(`${path}: expected ${expected}, got ${JSON.stringify(got)}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'an object', value);
  }
  return value as Record<string, unknown>;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array', value);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string', value);
  return value;
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a number', value);
  return value;
}

function nullableStr(value: unknown, path: string): string | null {
  if (value === null) return null;
  return str(value, path);
}

function parseSpan(value: unknown, path: string): Span | null {
  if (value === null || value === undefined) return null;
  const raw = obj(value, path);
  return { start: num(raw.start, `${path}.start`), end: num(raw.end, `${path}.end`) };
}

function parseField(value: unknown, path: string, text: string): ExtractedField {
  const raw = obj(value, path);
  const field: ExtractedField = {
    key: str(raw.key, `${path}.key`),
    label: str(raw.label, `${path}.label`),
    question: str(raw.question, `${path}.question`),
    value: nullableStr(raw.value, `${path}.value`),
    quote: nullableStr(raw.quote, `${path}.quote`),
    span: parseSpan(raw.span, `${path}.span`),
    occurrences: num(raw.occurrences, `${path}.occurrences`),
  };

  if (field.span) {
    const { start, end } = field.span;
    if (start < 0 || end > text.length || start >= end) {
      fail(`${path}.span`, `a range inside 0..${text.length}`, field.span);
    }
    if (field.quote === null) {
      fail(`${path}.quote`, 'a quote, because a span was given', null);
    }
    if (normalise(text.slice(start, end)) !== normalise(field.quote)) {
      fail(
        `${path}.span`,
        `a range whose text matches the quote (found ${JSON.stringify(
          text.slice(start, end).slice(0, 40),
        )})`,
        field.span,
      );
    }
  }

  // A value with no quote at all is not rejected -- the pipeline emits exactly that for
  // "the document does not state this", where there is nothing to quote. It is only
  // suspicious when the value is non-null, and the screen shows that as 根拠なし rather
  // than refusing to load: hiding a field because its evidence is missing is how the
  // weakest answer in the batch becomes the one nobody reviews.
  return field;
}

function parseDocument(value: unknown, path: string): ExtractionDocument {
  const raw = obj(value, path);
  const text = str(raw.text, `${path}.text`);
  const fields = arr(raw.fields, `${path}.fields`).map((f, i) =>
    parseField(f, `${path}.fields[${i}]`, text),
  );
  if (fields.length === 0) fail(`${path}.fields`, 'at least one field', fields);

  const keys = new Set(fields.map((f) => f.key));
  if (keys.size !== fields.length) {
    fail(`${path}.fields`, 'unique field keys', fields.map((f) => f.key));
  }

  return {
    id: str(raw.id, `${path}.id`),
    title: str(raw.title, `${path}.title`),
    text,
    fields,
  };
}

function parseRun(value: unknown, path: string): Run {
  const raw = obj(value, path);
  return {
    model: str(raw.model, `${path}.model`),
    region: str(raw.region, `${path}.region`),
    prompt: str(raw.prompt, `${path}.prompt`),
    calls: num(raw.calls, `${path}.calls`),
    input_tokens: num(raw.input_tokens, `${path}.input_tokens`),
    output_tokens: num(raw.output_tokens, `${path}.output_tokens`),
    seconds: num(raw.seconds, `${path}.seconds`),
    truncated: num(raw.truncated, `${path}.truncated`),
    documents: num(raw.documents, `${path}.documents`),
    fields_per_document: num(raw.fields_per_document, `${path}.fields_per_document`),
    ungrounded_quotes: num(raw.ungrounded_quotes, `${path}.ungrounded_quotes`),
    ambiguous_quotes: num(raw.ambiguous_quotes, `${path}.ambiguous_quotes`),
    errors: arr(raw.errors, `${path}.errors`).map((e, i) => str(e, `${path}.errors[${i}]`)),
  };
}

export function parseBundle(value: unknown): Bundle {
  const raw = obj(value, 'bundle');
  const documents = arr(raw.documents, 'bundle.documents').map((d, i) =>
    parseDocument(d, `bundle.documents[${i}]`),
  );
  if (documents.length === 0) fail('bundle.documents', 'at least one document', documents);
  return {
    generated: str(raw.generated, 'bundle.generated'),
    revision: num(raw.revision, 'bundle.revision'),
    run: parseRun(raw.run, 'bundle.run'),
    documents,
  };
}

/** Fetch and parse. The fetcher is injectable so tests do not touch the network. */
export async function loadBundle(url: string, fetcher: typeof fetch = fetch): Promise<Bundle> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new BundleError(`${url}: HTTP ${response.status}`);
  }
  return parseBundle(await response.json());
}
