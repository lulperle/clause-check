import type { Bundle, ExtractedField, ExtractionDocument, Run } from '../types';

/** A short contract with two clauses that a span can point into. */
export const TEXT = [
  '第5条（支払）',
  '甲は、請求書を受領した月の翌月末日までに委託料を支払う。',
  '',
  '第9条（管轄）',
  '本契約に関する紛争は、東京地方裁判所を専属的合意管轄裁判所とする。',
].join('\n');

export function at(quote: string) {
  const start = TEXT.indexOf(quote);
  if (start === -1) throw new Error(`fixture text does not contain ${quote}`);
  return { start, end: start + quote.length };
}

export function field(over: Partial<ExtractedField> = {}): ExtractedField {
  const quote = '甲は、請求書を受領した月の翌月末日までに委託料を支払う。';
  return {
    key: 'payment_due',
    label: '支払期日',
    question: '支払期日を記載してください。',
    value: '請求書を受領した月の翌月末日',
    quote,
    span: at(quote),
    occurrences: 1,
    ...over,
  };
}

export function document(over: Partial<ExtractionDocument> = {}): ExtractionDocument {
  return {
    id: 'sample',
    title: '業務委託基本契約書',
    text: TEXT,
    fields: [field()],
    ...over,
  };
}

export function run(over: Partial<Run> = {}): Run {
  return {
    model: 'us.anthropic.claude-sonnet-5',
    region: 'us-west-2',
    prompt: 'guarded',
    calls: 1,
    input_tokens: 100,
    output_tokens: 10,
    seconds: 1.2,
    truncated: 0,
    documents: 1,
    fields_per_document: 1,
    ungrounded_quotes: 0,
    ambiguous_quotes: 0,
    errors: [],
    ...over,
  };
}

export function bundle(over: Partial<Bundle> = {}): Bundle {
  return {
    generated: '2026-09-12T00:00:00+00:00',
    revision: 1,
    run: run(),
    documents: [document()],
    ...over,
  };
}
