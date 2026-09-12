import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_DEPTH } from '../graphql';
import { start, type Api } from './harness';

let api: Api;
beforeAll(async () => {
  api = await start();
});
afterAll(() => api.close());

describe('the GraphQL interface', () => {
  it('returns exactly the fields asked for', async () => {
    const { body } = await api.graphql('{ documents { id title } }');
    expect(body.data.documents).toHaveLength(4);
    expect(Object.keys(body.data.documents[0])).toEqual(['id', 'title']);
  });

  it('serves the same spans the REST route serves', async () => {
    const graph = await api.graphql(
      '{ document(id: "gyomu-itaku") { fields { key quote span { start end } grounded } } }',
    );
    const restful = await api.get('/documents/gyomu-itaku/fields');
    for (const field of graph.body.data.document.fields) {
      const same = restful.body.fields.find((f: { key: string }) => f.key === field.key);
      expect(field.span).toEqual(same.span);
      expect(field.grounded).toBe(same.grounded);
    }
  });

  it('reports a failed request with a 200 and an errors array', async () => {
    // The finding, not a bug in this server: the specification puts application errors in
    // the body, so a status-code dashboard sees a healthy service while every request is
    // failing. Anyone deploying this needs to alert on `errors`, not on 5xx.
    const { status, body } = await api.graphql(
      '{ verify(document: "no-such-contract", quote: "甲は乙に") { grounded } }',
    );
    expect(status).toBe(200);
    expect(body.errors[0].message).toContain('no such document');
    expect(body.data).toBeNull();
  });

  it('cannot distinguish a missing document from a null field without asking twice', async () => {
    // The other half of the same problem, and the more dangerous half: this is a 200 with
    // no errors at all, because `document` is nullable. REST answers 404 here.
    const { status, body } = await api.graphql('{ document(id: "no-such-contract") { title } }');
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.document).toBeNull();
  });

  it('catches a misspelled field before executing anything, which REST cannot', async () => {
    const { status, body } = await api.graphql('{ document(id: "saas-riyo") { nonsense } }');
    expect(status).toBe(400);
    expect(body.errors[0].message).toContain('Cannot query field');
    // Nothing ran, so there is no partial data to mistake for an answer.
    expect(body.data).toBeUndefined();
  });

  it('refuses a query nested past the depth limit', async () => {
    const deep = `{ documents { fields { ${'comparison { '.repeat(5)}value ${'}'.repeat(5)} } } }`;
    const { status, body } = await api.graphql(deep);
    expect(status).toBe(400);
    expect(body.errors[0].extensions.code).toBe('DEPTH_LIMIT_EXCEEDED');
    expect(body.errors[0].extensions.limit).toBe(MAX_DEPTH);
  });

  it('allows the deepest query the screen actually needs', async () => {
    const { status, body } = await api.graphql(
      '{ documents { fields { comparison { span { start } } } } }',
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
  });

  it('refuses a query whose estimated cost is too high', async () => {
    const wide = `{ documents { fields { ${Array.from({ length: 40 }, () => 'key label question value quote occurrences').join(' ')} } } }`;
    const { status, body } = await api.graphql(wide);
    expect(status).toBe(400);
    expect(body.errors[0].extensions.code).toBe('COST_LIMIT_EXCEEDED');
  });

  it('counts one extra resolver call per field for the cross-run comparison', async () => {
    // The N+1, in numbers rather than in a warning: 1 for documents, 4 for their field
    // lists, and one per field for `comparison`.
    const { body } = await api.graphql('{ documents { fields { key comparison { value } } } }');
    const fields = body.data.documents.reduce(
      (total: number, doc: { fields: unknown[] }) => total + doc.fields.length,
      0,
    );
    expect(body.extensions.resolverCalls).toBe(1 + 4 + fields);
  });

  it('does not charge for the comparison when nobody asks for it', async () => {
    const { body } = await api.graphql('{ documents { fields { key value } } }');
    expect(body.extensions.resolverCalls).toBe(5);
  });

  it('reads the naive run when the request says so', async () => {
    const { body } = await api.graphql('{ documents { ungrounded } }', { prompt: 'naive' });
    const total = body.data.documents.reduce((n: number, d: { ungrounded: number }) => n + d.ungrounded, 0);
    expect(total).toBe(1);
  });

  it('rejects a syntactically broken query with a 400', async () => {
    const { status, body } = await api.graphql('{ documents { id ');
    expect(status).toBe(400);
    expect(body.errors).toHaveLength(1);
  });

  it('takes POST only', async () => {
    const { status } = await api.get('/graphql');
    expect(status).toBe(405);
  });
});
