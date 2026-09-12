/**
 * The REST half. Plain `node:http` and a switch, no framework.
 *
 * Not a purity exercise: this file is one of the three arms of a comparison, and a
 * framework would decide the interesting parts for me. Status codes, the error body, what
 * a collection response includes and what it makes you ask for again -- those are the
 * design, and hand-rolling them is what makes the README's comparison mine rather than
 * Express's defaults.
 *
 * Decisions worth naming, because each is a question an interviewer can reasonably ask:
 *
 * - `GET /documents` does **not** include `text`. The contracts are 2-3 KB each and a
 *   client listing four of them to render tabs does not need 10 KB of contract prose. This
 *   is the over-fetching the GraphQL arm is supposed to fix, and measuring it needs the
 *   REST side to be a *reasonable* REST API, not a strawman that returns everything.
 * - A missing field is 404 with the same body shape as every other error. A caller that
 *   has to parse two error shapes ends up parsing neither.
 * - `?prompt=naive` selects the run. It is a query parameter rather than a path segment
 *   because it selects a *view* of the same resources, and `/naive/documents/...` would
 *   duplicate every route to say so.
 * - 405 with `Allow` on a known path with the wrong method, not 404. The distinction tells
 *   a client whether to fix the URL or the verb.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ExtractedField, ExtractionDocument } from '../src/types';
import type { Prompt, Store } from './store';

export interface Problem {
  error: string;
  detail: string;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function problem(res: ServerResponse, status: number, error: string, detail: string, headers = {}) {
  send(res, status, { error, detail } satisfies Problem, headers);
}

/** `guarded` unless asked otherwise, and an unknown value is an error rather than a
 *  silent fallback: a typo in `?prompt=naiv` returning the guarded run would make the
 *  measured difference between the two impossible to trust. */
function readPrompt(url: URL): Prompt | { bad: string } {
  const raw = url.searchParams.get('prompt');
  if (raw === null || raw === 'guarded') return 'guarded';
  if (raw === 'naive') return 'naive';
  return { bad: raw };
}

/** A field without the document text repeated inside it. */
function fieldView(field: ExtractedField, documentId: string) {
  return {
    document: documentId,
    key: field.key,
    label: field.label,
    question: field.question,
    value: field.value,
    quote: field.quote,
    span: field.span,
    occurrences: field.occurrences,
    /** Derived rather than stored, so a client cannot forget to compute it. This is the
     *  one number a reviewer must not miss, and leaving it implicit in `span === null`
     *  means every consumer reimplements the rule. */
    grounded: field.quote === null ? null : field.span !== null,
  };
}

function documentSummary(doc: ExtractionDocument) {
  return {
    id: doc.id,
    title: doc.title,
    characters: doc.text.length,
    fields: doc.fields.length,
    ungrounded: doc.fields.filter((f) => f.quote !== null && f.span === null).length,
  };
}

export function handle(store: Store, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const prompt = readPrompt(url);
  if (typeof prompt !== 'string') {
    problem(res, 400, 'bad_prompt', `prompt must be guarded or naive, got ${JSON.stringify(prompt.bad)}`);
    return;
  }

  const get = req.method === 'GET';

  // GET /runs -- what produced the data, including which prompt. Cheap and first because
  // a client that does not know which run it is reading cannot interpret anything else.
  if (parts.length === 1 && parts[0] === 'runs') {
    if (!get) return problem(res, 405, 'method_not_allowed', 'read-only', { allow: 'GET' });
    return send(res, 200, {
      guarded: store.bundle('guarded').run,
      naive: store.bundle('naive').run,
    });
  }

  if (parts[0] === 'documents') {
    if (parts.length === 1) {
      if (!get) return problem(res, 405, 'method_not_allowed', 'read-only', { allow: 'GET' });
      return send(res, 200, { documents: store.bundle(prompt).documents.map(documentSummary) });
    }

    const id = decodeURIComponent(parts[1]);
    const doc = store.document(prompt, id);
    if (!doc) return problem(res, 404, 'no_such_document', `no document with id ${JSON.stringify(id)}`);

    if (parts.length === 2) {
      if (!get) return problem(res, 405, 'method_not_allowed', 'read-only', { allow: 'GET' });
      // The full representation, text included: this is the one place a client asks for
      // the contract itself, and highlighting requires the exact characters the spans
      // index into.
      return send(res, 200, {
        ...documentSummary(doc),
        text: doc.text,
        fields: doc.fields.map((f) => fieldView(f, doc.id)),
      });
    }

    if (parts.length === 3 && parts[2] === 'fields') {
      if (!get) return problem(res, 405, 'method_not_allowed', 'read-only', { allow: 'GET' });
      return send(res, 200, { fields: doc.fields.map((f) => fieldView(f, doc.id)) });
    }

    if (parts.length === 4 && parts[2] === 'fields') {
      const key = decodeURIComponent(parts[3]);
      const field = store.field(prompt, id, key);
      if (!field) return problem(res, 404, 'no_such_field', `document ${id} has no field ${JSON.stringify(key)}`);
      if (!get) return problem(res, 405, 'method_not_allowed', 'read-only', { allow: 'GET' });
      return send(res, 200, fieldView(field, doc.id));
    }

    if (parts.length === 3 && parts[2] === 'verify') {
      if (req.method !== 'POST') {
        return problem(res, 405, 'method_not_allowed', 'verification takes a body', { allow: 'POST' });
      }
      let body = '';
      req.setEncoding('utf-8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        let quote: unknown;
        try {
          quote = (JSON.parse(body || '{}') as { quote?: unknown }).quote;
        } catch {
          return problem(res, 400, 'malformed_json', 'the request body is not JSON');
        }
        if (typeof quote !== 'string' || quote.trim() === '') {
          return problem(res, 422, 'missing_quote', 'body must be {"quote": "…"} with a non-empty string');
        }
        // 200 whether or not the quote is found: "this sentence is not in the contract" is
        // a successful answer to the question asked, and a 404 here would make a caller's
        // retry logic treat the most interesting result as an outage.
        return send(res, 200, store.verify(prompt, id, quote));
      });
      return;
    }
  }

  problem(res, 404, 'no_such_route', `${req.method} ${path} is not a route on this API`);
}
