/**
 * The MCP half. Same store, same data, a different kind of consumer.
 *
 * REST and GraphQL are read by code somebody wrote on purpose. MCP is read by a model, and
 * every difference below follows from that one fact:
 *
 * - **The descriptions are the interface.** In REST, prose in an OpenAPI file is
 *   documentation: a client that ignores it still works. Here the description string is
 *   what the model sees at decision time, so it is load-bearing in the same way a
 *   parameter name is. This repository already measured the size of that effect on the
 *   extraction itself -- the guarded prompt scored 36/36 against the naive prompt's 34/36
 *   with a fabricated quotation -- so the tool descriptions here are written the way the
 *   guarded prompt is written: say what an empty answer means, and say when *not* to call.
 * - **Failures come back inside a successful result.** `isError: true` with the reason in
 *   the text, not a thrown protocol error. A model that receives "that document id does not
 *   exist, the four ids are …" fixes its own call; a model that receives a 404 with no body
 *   usually tries the same call again. So each error here names the alternatives.
 * - **`verify_quote` is the tool that justifies the arm.** An agent quoting a contract can
 *   fabricate a plausible sentence, and the fabrication reads better than the real clause.
 *   This tool makes the check something the server does mechanically, and something the
 *   transcript records. It is the one tool here that is not a read of stored data.
 *
 * What I did *not* do: expose `text` on `get_document` by default. A 2-3 KB contract per
 * call is context the model pays for on every subsequent turn, so it is opt-in via
 * `include_text`. Same over-fetching question as the REST arm, but the cost lands on the
 * consumer's context window rather than on the wire.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { ExtractedField } from '../src/types';
import { openStore, type Prompt, type Store } from './store';

const promptArg = z
  .enum(['guarded', 'naive'])
  .default('guarded')
  .describe(
    'Which extraction run to read. "guarded" is the run whose prompt requires a verbatim quotation; ' +
      '"naive" is the control run kept for comparison and contains one known fabricated quotation. ' +
      'Read "guarded" unless you are specifically investigating the difference between the two.',
  );

/** One JSON payload, plus the same JSON as text because not every client renders
 *  structured content yet. Duplication is deliberate and cheap. */
function result(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text' as const, text }], structuredContent: payload as Record<string, unknown> };
}

function failure(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function fieldView(field: ExtractedField) {
  return {
    key: field.key,
    label: field.label,
    question: field.question,
    value: field.value,
    quote: field.quote,
    span: field.span,
    occurrences: field.occurrences,
    grounded: field.quote === null ? null : field.span !== null,
  };
}

export function buildServer(store: Store): McpServer {
  const server = new McpServer(
    { name: 'clause-check', version: '1.0.0' },
    {
      instructions:
        'Four fictional Japanese contracts with nine extracted fields each, and the spans in the ' +
        'contract text that each answer came from. A field whose value is null means the contract ' +
        'does not state it, which is an answer and not a failure. Never present a quotation from ' +
        'these contracts without verify_quote confirming it: the stored quotations were checked at ' +
        'extraction time, but any passage you compose yourself has not been.',
    },
  );

  const ids = (prompt: Prompt) => store.bundle(prompt).documents.map((d) => d.id).join(', ');

  server.registerTool(
    'list_documents',
    {
      title: 'List the contracts',
      description:
        'The four contracts available, with their ids, titles, length in characters, and how many ' +
        'of their extracted quotations could not be located in the contract text. Call this first; ' +
        'every other tool takes an id from here. Does not return contract text.',
      inputSchema: { prompt: promptArg },
      annotations: { readOnlyHint: true },
    },
    ({ prompt }) =>
      result({
        prompt,
        documents: store.bundle(prompt).documents.map((doc) => ({
          id: doc.id,
          title: doc.title,
          characters: doc.text.length,
          fields: doc.fields.length,
          ungrounded: doc.fields.filter((f) => f.quote !== null && f.span === null).length,
        })),
      }),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Read one contract',
      description:
        'All nine extracted fields for one contract. Each field carries the quotation it came from ' +
        'and the span of the contract text where that quotation was found; grounded is false if the ' +
        'quotation could not be located, which means the value is unsupported and should not be ' +
        'repeated. Set include_text only if you need the contract prose itself -- it is 2-3 KB and ' +
        'the fields usually answer the question without it.',
      inputSchema: {
        id: z.string().describe('A document id from list_documents, e.g. "gyomu-itaku".'),
        include_text: z
          .boolean()
          .default(false)
          .describe('Include the full contract text. Off by default because it is large.'),
        prompt: promptArg,
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, include_text, prompt }) => {
      const doc = store.document(prompt, id);
      if (!doc) return failure(`No contract has the id ${JSON.stringify(id)}. The ids are: ${ids(prompt)}.`);
      return result({
        id: doc.id,
        title: doc.title,
        characters: doc.text.length,
        fields: doc.fields.map(fieldView),
        ...(include_text ? { text: doc.text } : {}),
      });
    },
  );

  server.registerTool(
    'get_clause_field',
    {
      title: 'Read one extracted field',
      description:
        'One field of one contract, when you already know which field you want. A value of null ' +
        'means the contract is silent on this point -- report that as "the contract does not state ' +
        'it", not as missing data or as an extraction error.',
      inputSchema: {
        id: z.string().describe('A document id from list_documents.'),
        key: z
          .string()
          .describe('A field key as returned by get_document, e.g. "jurisdiction" or "auto_renewal".'),
        prompt: promptArg,
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, key, prompt }) => {
      const doc = store.document(prompt, id);
      if (!doc) return failure(`No contract has the id ${JSON.stringify(id)}. The ids are: ${ids(prompt)}.`);
      const field = store.field(prompt, id, key);
      if (!field) {
        return failure(
          `Contract ${id} has no field ${JSON.stringify(key)}. Its fields are: ` +
            `${doc.fields.map((f) => f.key).join(', ')}.`,
        );
      }
      return result({ document: id, ...fieldView(field) });
    },
  );

  server.registerTool(
    'verify_quote',
    {
      title: 'Check a quotation against the contract',
      description:
        'Searches the contract for a passage and reports whether it is really there, ignoring ' +
        'whitespace and full-width/half-width differences. Call this before you present any ' +
        'quotation you assembled, paraphrased, or recall from earlier in this conversation. ' +
        'grounded: false means the passage is not in the contract -- do not quote it, and say so ' +
        'rather than rewording it until it passes. occurrences above 1 means the passage is not ' +
        'unique, so a citation to it is ambiguous.',
      inputSchema: {
        id: z.string().describe('A document id from list_documents.'),
        quote: z.string().min(1).describe('The exact passage you intend to present, as you would present it.'),
        prompt: promptArg,
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, quote, prompt }) => {
      const doc = store.document(prompt, id);
      if (!doc) return failure(`No contract has the id ${JSON.stringify(id)}. The ids are: ${ids(prompt)}.`);
      const verification = store.verify(prompt, id, quote);
      // Not an error: "this passage is not in the contract" is the answer the caller asked
      // for, and the most useful one this tool produces.
      return result(verification);
    },
  );

  server.registerTool(
    'compare_runs',
    {
      title: 'Compare the two runs on one field',
      description:
        'The guarded and naive runs side by side for a single field, with whether they agree. Use ' +
        'this to answer questions about how the two prompts differ; for the contract itself, read ' +
        'the guarded run and ignore the naive one.',
      inputSchema: {
        id: z.string().describe('A document id from list_documents.'),
        key: z.string().describe('A field key, e.g. "jurisdiction".'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, key }) => {
      const { guarded, naive } = store.compare(id, key);
      if (!guarded && !naive) {
        return failure(`Neither run has a field ${JSON.stringify(key)} for a contract ${JSON.stringify(id)}.`);
      }
      return result({
        document: id,
        key,
        agree: (guarded?.value ?? null) === (naive?.value ?? null),
        guarded: guarded ? fieldView(guarded) : null,
        naive: naive ? fieldView(naive) : null,
      });
    },
  );

  return server;
}

/** stdio, because that is what an editor or desktop client launches. Nothing is written to
 *  stdout except protocol frames -- a stray console.log here corrupts the stream, which is
 *  why the store's errors go through `failure` rather than being printed. */
export async function main(): Promise<void> {
  const server = buildServer(openStore());
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    process.stderr.write(`clause-check mcp failed to start: ${String(cause)}\n`);
    process.exit(1);
  });
}
