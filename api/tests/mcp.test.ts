import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../mcp';
import { store } from './harness';

let client: Client;
let stop: () => Promise<unknown>;

/** A real client over the SDK's in-memory transport, so the protocol layer is exercised --
 *  schema validation of arguments, structured content, the isError flag -- without spawning
 *  a process. Calling the handler functions directly would skip exactly the parts that
 *  distinguish MCP from a function call. */
beforeAll(async () => {
  const server = buildServer(store());
  client = new Client({ name: 'test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  stop = () => Promise.all([client.close(), server.close()]);
});
afterAll(() => stop());

const json = (result: unknown) =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text;

describe('the MCP interface', () => {
  it('exposes five tools, all marked read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_runs',
      'get_clause_field',
      'get_document',
      'list_documents',
      'verify_quote',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('describes every tool, because the description is what the model reads', async () => {
    // Not a style rule. In MCP the description is in the model's context at decision time,
    // so an undescribed tool is an unusable one -- the same effect this repository measured
    // between the guarded and naive extraction prompts.
    const { tools } = await client.listTools();
    for (const tool of tools) expect((tool.description ?? '').length).toBeGreaterThan(80);
  });

  it('tells the model what a null value means, in the tool descriptions themselves', async () => {
    const { tools } = await client.listTools();
    const said = tools.map((t) => t.description ?? '').join('\n');
    // 'the contract does not state it' is the single most misread answer in this data set,
    // so it is stated where the model will see it rather than only in the README.
    expect(said).toContain('does not state');
  });

  it('lists the contracts without their text', async () => {
    const listed = json(await client.callTool({ name: 'list_documents', arguments: {} }));
    expect(listed.documents).toHaveLength(4);
    expect(listed.documents[0]).not.toHaveProperty('text');
  });

  it('keeps the contract text out of the context unless asked', async () => {
    const without = json(await client.callTool({ name: 'get_document', arguments: { id: 'saas-riyo' } }));
    const with_ = json(
      await client.callTool({ name: 'get_document', arguments: { id: 'saas-riyo', include_text: true } }),
    );
    expect(without).not.toHaveProperty('text');
    expect(with_.text.length).toBeGreaterThan(1000);
  });

  it('names the valid ids when the id is wrong, so the model can fix its own call', async () => {
    const result = await client.callTool({ name: 'get_document', arguments: { id: 'nope' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('saas-riyo');
  });

  it('names the valid field keys when the key is wrong', async () => {
    const result = await client.callTool({
      name: 'get_clause_field',
      arguments: { id: 'saas-riyo', key: 'nope' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('jurisdiction');
  });

  it('treats an absent quotation as a successful answer, not an error', async () => {
    const result = await client.callTool({
      name: 'verify_quote',
      arguments: { id: 'saas-riyo', quote: '本契約は無期限に自動更新される' },
    });
    expect(result.isError).toBeFalsy();
    expect(json(result).grounded).toBe(false);
  });

  it('confirms a quotation that is really in the contract, and says where', async () => {
    const doc = json(await client.callTool({ name: 'get_document', arguments: { id: 'saas-riyo', include_text: true } }));
    const field = doc.fields.find((f: { span: unknown }) => f.span !== null);
    const result = json(await client.callTool({
      name: 'verify_quote',
      arguments: { id: 'saas-riyo', quote: field.quote },
    }));
    expect(result.grounded).toBe(true);
    expect(result.span).toEqual(field.span);
    // The passage as the contract writes it, so a caller can check rather than trust.
    expect(doc.text.slice(result.span.start, result.span.end)).toBe(result.passage);
  });

  it('refuses the fabricated quotation the naive run produced', async () => {
    // This is the tool justifying its existence against a real artifact rather than an
    // invented one: the naive run's one ungrounded quotation is in the committed bundle.
    const bundle = store().bundle('naive');
    const fabricated = bundle.documents
      .flatMap((doc) => doc.fields.map((field) => ({ doc, field })))
      .find(({ field }) => field.quote !== null && field.span === null);
    expect(fabricated).toBeDefined();
    const result = json(await client.callTool({
      name: 'verify_quote',
      arguments: { id: fabricated!.doc.id, quote: fabricated!.field.quote, prompt: 'naive' },
    }));
    expect(result.grounded).toBe(false);
    expect(result.occurrences).toBe(0);
  });

  it('rejects a blank quotation at the schema layer, and tells the model why', async () => {
    // zod's min(1) means an empty quote never reaches the handler, so the model cannot get
    // a confident `false` back. Worth noting how this arrives: not as a thrown protocol
    // error but as `isError: true` with the validation message in the text, so the model
    // reads "expected string to have >=1 characters" and can correct itself. The REST arm's
    // equivalent is a 422 that only the calling code sees.
    const result = await client.callTool({
      name: 'verify_quote',
      arguments: { id: 'saas-riyo', quote: '' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('quote');
  });

  it('compares the two runs on one field and says whether they agree', async () => {
    const result = json(await client.callTool({
      name: 'compare_runs',
      arguments: { id: 'saas-riyo', key: 'jurisdiction' },
    }));
    expect(result.guarded).not.toBeNull();
    expect(result.naive).not.toBeNull();
    expect(typeof result.agree).toBe('boolean');
  });

  it('returns structured content alongside the text', async () => {
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    expect((result.structuredContent as { documents: unknown[] }).documents).toHaveLength(4);
  });

  it('defaults to the guarded run', async () => {
    const listed = json(await client.callTool({ name: 'list_documents', arguments: {} }));
    expect(listed.prompt).toBe('guarded');
    expect(listed.documents.every((d: { ungrounded: number }) => d.ungrounded === 0)).toBe(true);
  });
});
