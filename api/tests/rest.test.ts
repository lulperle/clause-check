import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { start, type Api } from './harness';

let api: Api;
beforeAll(async () => {
  api = await start();
});
afterAll(() => api.close());

describe('the REST interface', () => {
  it('lists the four contracts without their text', async () => {
    const { status, body } = await api.get('/documents');
    expect(status).toBe(200);
    expect(body.documents).toHaveLength(4);
    // The over-fetching decision, asserted: a collection route that quietly starts
    // returning 2-3 KB of contract prose per item is the regression this catches.
    expect(body.documents[0]).not.toHaveProperty('text');
    expect(body.documents[0]).toMatchObject({ id: expect.any(String), characters: expect.any(Number) });
  });

  it('returns the contract text on the single-document route, because spans index into it', async () => {
    const { body } = await api.get('/documents/gyomu-itaku');
    expect(typeof body.text).toBe('string');
    expect(body.characters).toBe(body.text.length);
    const field = body.fields.find((f: { span: unknown }) => f.span !== null);
    // The span has to address the text as served. Whitespace is stripped on both sides
    // before comparing, because the contracts are hard-wrapped and the model quotes a
    // clause as one line -- that difference is exactly what the grounding search ignores.
    // What must hold is that the span covers the quoted clause and nothing else: if the
    // text were reformatted or the width normalised, this slice would land elsewhere.
    const strip = (s: string) => s.replace(/[\s　]/gu, '');
    expect(strip(body.text.slice(field.span.start, field.span.end))).toBe(strip(field.quote));
  });

  it('derives grounded so a consumer cannot forget the rule', async () => {
    const { body } = await api.get('/documents/gyomu-itaku/fields');
    for (const field of body.fields) {
      expect(field.grounded).toBe(field.quote === null ? null : field.span !== null);
    }
  });

  it('distinguishes an absent field from an absent document', async () => {
    expect((await api.get('/documents/nope')).body.error).toBe('no_such_document');
    expect((await api.get('/documents/saas-riyo/fields/nope')).body.error).toBe('no_such_field');
    expect((await api.get('/documents/nope')).status).toBe(404);
    expect((await api.get('/documents/saas-riyo/fields/nope')).status).toBe(404);
  });

  it('uses one error shape everywhere', async () => {
    for (const path of ['/documents/nope', '/documents/saas-riyo/fields/nope', '/nonsense']) {
      const { body } = await api.get(path);
      expect(Object.keys(body).sort()).toEqual(['detail', 'error']);
    }
  });

  it('answers 405 with Allow on a known path with the wrong verb', async () => {
    const { status, headers } = await api.post('/documents', {});
    expect(status).toBe(405);
    // The distinction a client needs: fix the verb, not the URL.
    expect(headers.get('allow')).toBe('GET');
  });

  it('refuses an unrecognised prompt instead of silently serving the guarded run', async () => {
    const { status, body } = await api.get('/documents?prompt=naiv');
    expect(status).toBe(400);
    expect(body.error).toBe('bad_prompt');
  });

  it('serves the naive run when asked, and it differs from the guarded one', async () => {
    const guarded = await api.get('/documents/saas-riyo/fields');
    const naive = await api.get('/documents/saas-riyo/fields?prompt=naive');
    expect(naive.status).toBe(200);
    expect(JSON.stringify(naive.body)).not.toBe(JSON.stringify(guarded.body));
  });

  it('answers 200 when a quotation is absent, because that is a successful answer', async () => {
    const { status, body } = await api.post('/documents/saas-riyo/verify', {
      quote: '本契約は無期限に自動更新される',
    });
    expect(status).toBe(200);
    expect(body.grounded).toBe(false);
    expect(body.span).toBeNull();
    expect(body.passage).toBeNull();
  });

  it('finds a quotation that differs from the contract only in width and spacing', async () => {
    const doc = await api.get('/documents/saas-riyo');
    const field = doc.body.fields.find((f: { span: unknown }) => f.span !== null);
    const mangled = doc.body.text.slice(field.span.start, field.span.end).replace(/\s/g, '');
    const { body } = await api.post('/documents/saas-riyo/verify', { quote: mangled });
    expect(body.grounded).toBe(true);
    expect(body.span).toEqual(field.span);
  });

  it('rejects a blank quotation as unprocessable rather than answering it', async () => {
    // 422 rather than 400: the JSON parsed fine, the value is unusable. Answering `false`
    // would be worse than an error -- it reads as "the contract does not contain this".
    expect((await api.post('/documents/saas-riyo/verify', { quote: '   ' })).status).toBe(422);
    expect((await api.post('/documents/saas-riyo/verify', {})).status).toBe(422);
  });

  it('reports which run produced the data', async () => {
    const { body } = await api.get('/runs');
    expect(body.guarded.ungrounded_quotes).toBe(0);
    expect(body.naive.ungrounded_quotes).toBe(1);
  });
});
