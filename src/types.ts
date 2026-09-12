/**
 * The shape of `public/extraction.json`.
 *
 * snake_case, because these names belong to the producer (`pipeline/extract.py`) and
 * renaming them on the way in would mean two vocabularies for one thing: the field is
 * `absent_as_prose` in the score file, in the pipeline and in the README, so it is
 * `absent_as_prose` here too. Convention loses to being able to grep across the repo.
 */

/** A half-open range of `Document.text`, as `text.slice(start, end)`. */
export interface Span {
  start: number;
  end: number;
}

export interface ExtractedField {
  key: string;
  /** Japanese label shown to the reviewer. */
  label: string;
  /** What the model was asked, verbatim. Shown on demand: a reviewer disagreeing with a
   *  value needs to know which question it answered. */
  question: string;
  /** null means the model reported the document does not state this. */
  value: string | null;
  /** The passage the value came from, as the model quoted it. */
  quote: string | null;
  /** Where that quote is in `Document.text`, or null if it could not be found there.
   *  Null with a non-null quote is the interesting case: the value is attributed to a
   *  sentence that is not in the document. */
  span: Span | null;
  /** How many times the quote occurs. Above one, the highlight is the first of several
   *  and the UI says so rather than implying precision it does not have. */
  occurrences: number;
}

export interface ExtractionDocument {
  id: string;
  title: string;
  /** The contract as given to the model, character for character. Spans index into
   *  this, so it must not be reformatted anywhere between here and the highlight. */
  text: string;
  fields: ExtractedField[];
}

export interface Run {
  model: string;
  region: string;
  /** `guarded` or `naive` -- which prompt produced this bundle. Displayed, because the
   *  two differ in accuracy and a screen that hides which one it is loaded invites the
   *  reader to attribute the guarded numbers to the model. */
  prompt: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  seconds: number;
  truncated: number;
  documents: number;
  fields_per_document: number;
  ungrounded_quotes: number;
  ambiguous_quotes: number;
  errors: string[];
}

export interface Bundle {
  generated: string;
  revision: number;
  run: Run;
  documents: ExtractionDocument[];
}
