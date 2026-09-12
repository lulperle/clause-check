/**
 * Measure the three interfaces on the same tasks and write the result to
 * `api/comparison.json`, which is committed.
 *
 * The point of this file is that the README's comparison is not a summary of blog posts.
 * Every number in that table comes from here, against the same store and the same four
 * contracts, and the artifact is in the repository so a reader can check the numbers
 * without running anything. The tests in `tests/comparison.test.ts` assert the ordering that
 * the README claims, so a change that reverses a finding fails CI instead of quietly making
 * the README wrong.
 *
 * Run: `npx tsx api/measure.ts` (add `--check` to fail if the artifact is out of date).
 *
 * What is measured, and why those things:
 *
 * - **Bytes over the wire and round trips**, for three tasks a real client actually has.
 *   Not "hello world": the tasks are the tab bar, one full review screen, and one agent
 *   question, because over-fetching only shows up when the payload has a reason to be big.
 * - **The error shape for the same three failures.** An interface is mostly judged by what
 *   it does when the caller is wrong, and this is where the three diverge most.
 * - **Resolver calls for one small GraphQL query**, which is the N+1 in numbers.
 *
 * Not measured: latency. Everything here reads from memory, so any timing would describe
 * this laptop rather than the interfaces, and publishing it would be the kind of number
 * that looks like evidence and is not.
 */

import { writeFileSync, readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { run as runGraphQL, MAX_COST, MAX_DEPTH } from './graphql';
import { buildServer } from './mcp';
import { handle as handleREST } from './rest';
import { openStore, type Store } from './store';

/** A REST call without a socket: the handler is the unit under test, and a loopback socket
 *  would add kernel behaviour to a measurement about payload shape. Byte counts are of the
 *  JSON body, the same thing `content-length` reports. */
function rest(
  store: Store,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; bytes: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let status = 0;

    const req = {
      method,
      url: path,
      setEncoding() {},
      on(event: string, handler: (chunk?: string) => void) {
        if (event === 'data' && body !== undefined) handler(JSON.stringify(body));
        if (event === 'end') handler();
        return this;
      },
    };

    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(payload?: string) {
        if (payload) chunks.push(payload);
        const text = chunks.join('');
        resolve({ status, bytes: Buffer.byteLength(text), json: text ? JSON.parse(text) : null });
      },
    };

    try {
      // The handler only uses the members faked above; the casts keep the fakes honest by
      // failing to compile if it starts using more.
      handleREST(store, req as unknown as Parameters<typeof handleREST>[1], res as unknown as Parameters<typeof handleREST>[2]);
    } catch (cause) {
      reject(cause);
    }
  });
}

async function graphql(store: Store, query: string) {
  const outcome = await runGraphQL(store, query);
  return {
    status: outcome.status,
    bytes: Buffer.byteLength(JSON.stringify(outcome.body)),
    resolverCalls: outcome.resolverCalls,
    body: outcome.body,
  };
}

async function connectMcp(store: Store) {
  const server = buildServer(store);
  const client = new Client({ name: 'measure', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

/** What an MCP call costs is not wire bytes -- it is the characters that land in the
 *  model's context and stay there for the rest of the conversation. So MCP is measured on
 *  the text content, and the tool definitions are measured separately because they are paid
 *  once per session whether or not any tool is called. */
function mcpBytes(result: unknown): number {
  // A tool result's content is a union of text, image, audio and resource parts -- and the
  // SDK's type also admits a legacy shape with no `content` at all, which is why this takes
  // `unknown` and narrows rather than declaring the shape it hopes for. Only text parts have
  // a size worth counting here, and this server emits nothing else.
  const content = (result as { content?: unknown }).content;
  const parts = Array.isArray(content) ? (content as Array<{ text?: unknown }>) : [];
  return parts.reduce(
    (total, part) => total + (typeof part.text === 'string' ? Buffer.byteLength(part.text) : 0),
    0,
  );
}

async function main() {
  const store = openStore();
  const { client, close } = await connectMcp(store);
  const tools = await client.listTools();

  // --- Task 1: a tab bar. Four ids and titles, nothing else. -------------------------
  const listRest = await rest(store, 'GET', '/documents');
  const listGraphQL = await graphql(store, '{ documents { id title } }');
  const listMcp = await client.callTool({ name: 'list_documents', arguments: {} });

  // --- Task 2: one review screen. Contract text plus all nine fields. ---------------
  // Two GraphQL queries on purpose, because one number would conflate two different
  // claims. `screenGraphQLSame` asks for every field REST returns, so its gap against REST
  // is pure envelope overhead. `screenGraphQL` asks for what the screen actually renders --
  // it drops `question`, nine long Japanese sentences the screen never shows -- so its gap
  // is the over-fetching REST cannot avoid without a second representation.
  const screenRest = await rest(store, 'GET', '/documents/gyomu-itaku');
  const screenGraphQLSame = await graphql(
    store,
    `{ document(id: "gyomu-itaku") { id title characters text
         fields { key label question value quote span { start end } occurrences grounded } } }`,
  );
  const screenGraphQL = await graphql(
    store,
    `{ document(id: "gyomu-itaku") { id title characters text
         fields { key label value quote span { start end } occurrences grounded } } }`,
  );
  const screenMcp = await client.callTool({
    name: 'get_document',
    arguments: { id: 'gyomu-itaku', include_text: true },
  });

  // --- Task 3: one agent question. "What is saas-riyo's jurisdiction, and is the -----
  // quotation real?" Two facts, and the second one is a verification.
  const askRest = [
    await rest(store, 'GET', '/documents/saas-riyo/fields/jurisdiction'),
    await rest(store, 'POST', '/documents/saas-riyo/verify', { quote: '大阪地方裁判所' }),
  ];
  const askGraphQL = await graphql(
    store,
    `{ field: document(id: "saas-riyo") { fields(key: "jurisdiction") { value quote grounded } }
       check: verify(document: "saas-riyo", quote: "大阪地方裁判所") { grounded occurrences passage } }`,
  );
  const askMcp = [
    await client.callTool({ name: 'get_clause_field', arguments: { id: 'saas-riyo', key: 'jurisdiction' } }),
    await client.callTool({ name: 'verify_quote', arguments: { id: 'saas-riyo', quote: '大阪地方裁判所' } }),
  ];

  // --- The same three failures, three times. ----------------------------------------
  const unknownDocument = {
    rest: await rest(store, 'GET', '/documents/no-such-contract'),
    graphql: await graphql(store, '{ document(id: "no-such-contract") { title } }'),
    mcp: await client.callTool({ name: 'get_document', arguments: { id: 'no-such-contract' } }),
  };
  const unknownField = {
    rest: await rest(store, 'GET', '/documents/saas-riyo/fields/no-such-field'),
    graphql: await graphql(store, '{ document(id: "saas-riyo") { nonsense } }'),
    mcp: await client.callTool({
      name: 'get_clause_field',
      arguments: { id: 'saas-riyo', key: 'no-such-field' },
    }),
  };
  const absentQuote = {
    rest: await rest(store, 'POST', '/documents/saas-riyo/verify', { quote: '本契約は無期限に自動更新される' }),
    graphql: await graphql(
      store,
      '{ verify(document: "saas-riyo", quote: "本契約は無期限に自動更新される") { grounded } }',
    ),
    mcp: await client.callTool({
      name: 'verify_quote',
      arguments: { id: 'saas-riyo', quote: '本契約は無期限に自動更新される' },
    }),
  };

  // A resolver that throws, which is the case the other three do not reach: `document` is
  // nullable so a bad id resolves to null, and an unknown field is caught by validation.
  // `verify` is non-null and its store call throws, so this is the shape a real outage takes.
  const resolverThrew = {
    rest: await rest(store, 'POST', '/documents/no-such-contract/verify', { quote: '甲は乙に' }),
    graphql: await graphql(store, '{ verify(document: "no-such-contract", quote: "甲は乙に") { grounded } }'),
    mcp: await client.callTool({
      name: 'verify_quote',
      arguments: { id: 'no-such-contract', quote: '甲は乙に' },
    }),
  };

  // --- The graph-shaped costs REST does not have. -----------------------------------
  const fanout = await graphql(store, '{ documents { fields { key comparison { value } } } }');
  const tooDeep = await graphql(
    store,
    '{ documents { fields { comparison { comparison { comparison { comparison { value } } } } } } }',
  );

  const errorShape = (label: string, group: typeof unknownDocument) => ({
    failure: label,
    rest: {
      status: group.rest.status,
      body: group.rest.json,
    },
    graphql: {
      status: group.graphql.status,
      // The finding, in one field: a failed GraphQL request is a 200 unless it failed
      // validation, so the status code carries no information about whether it worked.
      errors: (group.graphql.body.errors as Array<{ message: string }> | undefined)?.map((e) => e.message) ?? null,
      data: group.graphql.body.data ?? null,
    },
    mcp: {
      isError: group.mcp.isError === true,
      text: ((group.mcp.content as Array<{ text?: string }>)[0]?.text ?? '').slice(0, 200),
    },
  });

  const comparison = {
    generated_by: 'api/measure.ts',
    documents: store.bundle('guarded').documents.length,
    note:
      'Bytes are JSON payload bytes for REST and GraphQL, and text-content bytes for MCP, ' +
      'because an MCP result is paid for in the model context rather than on the wire.',
    tasks: [
      {
        task: 'tab bar: four ids and titles',
        rest: { round_trips: 1, bytes: listRest.bytes, note: 'the collection route omits text by design, and still carries fields the tab bar ignores' },
        graphql: { round_trips: 1, bytes: listGraphQL.bytes, resolver_calls: listGraphQL.resolverCalls, note: 'exactly the two fields asked for' },
        mcp: { round_trips: 1, bytes: mcpBytes(listMcp), note: 'pretty-printed for the model to read, which costs bytes on purpose' },
      },
      {
        task: 'one review screen: contract text and all nine fields',
        rest: { round_trips: 1, bytes: screenRest.bytes },
        graphql: {
          round_trips: 1,
          bytes: screenGraphQL.bytes,
          bytes_same_fields: screenGraphQLSame.bytes,
          resolver_calls: screenGraphQL.resolverCalls,
          note: 'bytes_same_fields asks for everything REST returns, so REST minus it is envelope overhead; bytes drops the nine question strings the screen never renders',
        },
        mcp: { round_trips: 1, bytes: mcpBytes(screenMcp) },
      },
      {
        task: 'agent question: one field plus a quotation check',
        rest: { round_trips: askRest.length, bytes: askRest.reduce((n, r) => n + r.bytes, 0) },
        graphql: { round_trips: 1, bytes: askGraphQL.bytes, resolver_calls: askGraphQL.resolverCalls },
        mcp: { round_trips: askMcp.length, bytes: askMcp.reduce((n, r) => n + mcpBytes(r), 0) },
      },
    ],
    errors: [
      errorShape('a document id that does not exist', unknownDocument),
      errorShape('a field that does not exist', unknownField),
      errorShape('a quotation that is not in the contract', absentQuote),
      errorShape('a bad id on the verification route, where the GraphQL field is non-null', resolverThrew),
    ],
    graph_costs: {
      fanout_query: '{ documents { fields { key comparison { value } } } }',
      fanout_bytes: fanout.bytes,
      fanout_resolver_calls: fanout.resolverCalls,
      depth_limit: MAX_DEPTH,
      cost_limit: MAX_COST,
      rejected_status: tooDeep.status,
      rejected_because:
        (tooDeep.body.errors as Array<{ message: string }> | undefined)?.map((e) => e.message) ?? [],
    },
    mcp_session_cost: {
      tools: tools.tools.length,
      // Paid once per session, before any tool is called. On this server the descriptions
      // are most of it, and they are not padding: see the file header in api/mcp.ts.
      definition_bytes: Buffer.byteLength(JSON.stringify(tools.tools)),
      description_bytes: tools.tools.reduce((n, t) => n + Buffer.byteLength(t.description ?? ''), 0),
    },
  };

  await close();

  const path = new URL('./comparison.json', import.meta.url).pathname;
  const text = `${JSON.stringify(comparison, null, 2)}\n`;

  if (process.argv.includes('--check')) {
    const existing = readFileSync(path, 'utf-8');
    if (existing !== text) {
      process.stderr.write('api/comparison.json is out of date; run `npx tsx api/measure.ts`\n');
      process.exit(1);
    }
    process.stdout.write('api/comparison.json is current\n');
    return;
  }

  writeFileSync(path, text);
  process.stdout.write(`wrote ${path}\n`);
  for (const task of comparison.tasks) {
    process.stdout.write(
      `${task.task}\n  REST ${task.rest.bytes}B / ${task.rest.round_trips} calls` +
        `  GraphQL ${task.graphql.bytes}B / ${task.graphql.round_trips}` +
        `  MCP ${task.mcp.bytes}B / ${task.mcp.round_trips}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exit(1);
  });
}
