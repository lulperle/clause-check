/**
 * What the reviewer decided, and what that says about the extraction.
 *
 * A plain reducer over a plain object, deliberately outside React: every rule worth
 * getting right here -- what counts as reviewed, what counts as an override, what an
 * unreviewed screen should report -- is testable without rendering anything, and the
 * component is then a thin thing that dispatches.
 *
 * Three verdicts, not two. `corrected` and `rejected` both mean the model was wrong, but
 * they mean different things about the tool: a corrected value is a clause the model
 * found and mis-stated, a rejected one is a clause it should not have answered at all.
 * Collapsing them is how a tool reports "94% of fields accepted after light editing"
 * when a quarter of the answers were about the wrong clause.
 */

import type { Bundle, ExtractedField, ExtractionDocument } from './types';

export type Verdict = 'accepted' | 'corrected' | 'rejected';

export interface Decision {
  verdict: Verdict;
  /** Present only for `corrected`: what the reviewer says the value should be. */
  value?: string;
  note?: string;
}

/** Keyed `<document id>/<field key>`, which is stable across re-runs of the pipeline. */
export type Decisions = Record<string, Decision>;

export function keyOf(documentId: string, fieldKey: string): string {
  return `${documentId}/${fieldKey}`;
}

export type Action =
  | { type: 'accept'; key: string }
  | { type: 'correct'; key: string; value: string }
  | { type: 'reject'; key: string }
  | { type: 'note'; key: string; note: string }
  | { type: 'clear'; key: string }
  | { type: 'restore'; decisions: Decisions };

export function reduce(state: Decisions, action: Action): Decisions {
  switch (action.type) {
    case 'accept':
      return { ...state, [action.key]: { ...state[action.key], verdict: 'accepted', value: undefined } };
    case 'correct': {
      const value = action.value.trim();
      // An empty correction is a rejection, not a corrected value of "". Without this,
      // clearing the box and submitting exports a field whose agreed value is the empty
      // string, which downstream is indistinguishable from "the contract says nothing".
      if (value === '') {
        return { ...state, [action.key]: { ...state[action.key], verdict: 'rejected', value: undefined } };
      }
      return { ...state, [action.key]: { ...state[action.key], verdict: 'corrected', value } };
    }
    case 'reject':
      return { ...state, [action.key]: { ...state[action.key], verdict: 'rejected', value: undefined } };
    case 'note': {
      const existing = state[action.key];
      if (!existing) return state;
      return { ...state, [action.key]: { ...existing, note: action.note || undefined } };
    }
    case 'clear': {
      const next = { ...state };
      delete next[action.key];
      return next;
    }
    case 'restore':
      return action.decisions;
  }
}

export interface Summary {
  total: number;
  reviewed: number;
  accepted: number;
  corrected: number;
  rejected: number;
  /** Overrides as a share of what has been reviewed, or null before anything has been.
   *  Null rather than 0: a screen reporting "0% overridden" out of zero reviews is the
   *  most flattering number available and it means nothing. */
  overrideRate: number | null;
  /** Fields accepted whose quotation could not be found in the document.
   *  The number this screen exists to keep visible -- an accepted value with no locatable
   *  evidence is the tool being trusted exactly where it earned the least trust. */
  acceptedWithoutEvidence: number;
}

export function summarise(bundle: Bundle, decisions: Decisions): Summary {
  let total = 0;
  let accepted = 0;
  let corrected = 0;
  let rejected = 0;
  let acceptedWithoutEvidence = 0;

  for (const document of bundle.documents) {
    for (const field of document.fields) {
      total += 1;
      const decision = decisions[keyOf(document.id, field.key)];
      if (!decision) continue;
      if (decision.verdict === 'accepted') {
        accepted += 1;
        if (field.value !== null && field.span === null) acceptedWithoutEvidence += 1;
      }
      if (decision.verdict === 'corrected') corrected += 1;
      if (decision.verdict === 'rejected') rejected += 1;
    }
  }

  const reviewed = accepted + corrected + rejected;
  return {
    total,
    reviewed,
    accepted,
    corrected,
    rejected,
    overrideRate: reviewed === 0 ? null : (corrected + rejected) / reviewed,
    acceptedWithoutEvidence,
  };
}

/** Fields worth looking at first: a stated value whose evidence is missing or ambiguous.
 *
 *  Not a confidence ranking. It is derived from whether the *quotation* checks out, which
 *  is a property of this run and not an opinion of the model about itself. */
export function unverifiable(document: ExtractionDocument): ExtractedField[] {
  return document.fields.filter(
    (f) => f.value !== null && (f.span === null || f.occurrences > 1),
  );
}

/** What a session hands over: the agreed value per field, and how it was arrived at. */
export function toExport(bundle: Bundle, decisions: Decisions) {
  return {
    generated: new Date().toISOString(),
    source: { generated: bundle.generated, revision: bundle.revision, run: bundle.run },
    summary: summarise(bundle, decisions),
    fields: bundle.documents.flatMap((document) =>
      document.fields.map((field) => {
        const decision = decisions[keyOf(document.id, field.key)];
        return {
          document: document.id,
          field: field.key,
          label: field.label,
          extracted: field.value,
          quote: field.quote,
          grounded: field.span !== null,
          verdict: decision?.verdict ?? null,
          // The extracted value stands only where the reviewer accepted it; a rejected
          // field exports null rather than the model's answer, so a consumer of this file
          // cannot pick up a value a human refused.
          agreed:
            decision?.verdict === 'accepted'
              ? field.value
              : decision?.verdict === 'corrected'
                ? (decision.value ?? null)
                : null,
          note: decision?.note ?? null,
        };
      }),
    ),
  };
}

const STORAGE_KEY = 'clause-check/decisions/v1';

export function save(decisions: Decisions): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions));
}

/** Decisions from a previous session, or an empty set.
 *
 *  Anything unparseable is discarded silently and on purpose: a stored blob from an older
 *  key shape must not be able to stop the screen from opening. */
export function restore(): Decisions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Decisions;
  } catch {
    return {};
  }
}
