/**
 * The GraphQL half: schema, resolvers, and the two guards a schema like this needs.
 *
 * The schema is built programmatically rather than from SDL so the resolvers sit next to
 * the fields they serve and so `resolverCalls` can count them. That counter is not
 * decoration -- it is how the N+1 claim in the README is measured instead of asserted.
 *
 * What the arm is here to show:
 *
 * 1. **It fixes the over-fetching.** `documents { id title }` returns four ids and titles.
 *    The REST equivalent that also gives a client the option of the contract text either
 *    ships 10 KB nobody asked for or needs a second route. Measured in `measure.ts`.
 * 2. **It moves the cost problem to the server.** `documents { fields { comparison { … } } }`
 *    is one small query that fans out into a resolver call per field per document, and a
 *    client can nest it deeper for free. So this file ships a depth limit and a cost
 *    estimate as validation rules, which is work the REST arm never had to do because its
 *    shapes are fixed.
 * 3. **Errors arrive with a 200.** A field resolver that throws produces
 *    `{data: {...}, errors: [...]}` under a 200 response. Monitoring built on status codes
 *    -- which is most monitoring -- reads a schema-wide failure as a healthy service. The
 *    test named for this is the one worth reading.
 */

import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  execute,
  parse,
  specifiedRules,
  validate,
  type ASTNode,
  type ValidationContext,
} from 'graphql';

import type { ExtractedField, ExtractionDocument } from '../src/types';
import type { Prompt, Store } from './store';

export interface Context {
  store: Store;
  prompt: Prompt;
  /** Incremented by every resolver that has to look something up. The N+1 measurement. */
  resolverCalls: number;
}

interface FieldSource {
  field: ExtractedField;
  documentId: string;
}

const SpanType = new GraphQLObjectType({
  name: 'Span',
  description: 'A half-open range of the document text, as text.slice(start, end).',
  fields: {
    start: { type: new GraphQLNonNull(GraphQLInt) },
    end: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const FieldType: GraphQLObjectType<FieldSource, Context> = new GraphQLObjectType<FieldSource, Context>({
  name: 'Field',
  fields: () => ({
    key: { type: new GraphQLNonNull(GraphQLString), resolve: (s) => s.field.key },
    label: { type: new GraphQLNonNull(GraphQLString), resolve: (s) => s.field.label },
    question: { type: new GraphQLNonNull(GraphQLString), resolve: (s) => s.field.question },
    value: {
      type: GraphQLString,
      description: 'null means the contract does not state this, which is an answer.',
      resolve: (s) => s.field.value,
    },
    quote: { type: GraphQLString, resolve: (s) => s.field.quote },
    span: { type: SpanType, resolve: (s) => s.field.span },
    occurrences: { type: new GraphQLNonNull(GraphQLInt), resolve: (s) => s.field.occurrences },
    grounded: {
      type: GraphQLBoolean,
      description: 'null when there is no quote to ground; false when the quote is not in the document.',
      resolve: (s) => (s.field.quote === null ? null : s.field.span !== null),
    },
    comparison: {
      type: FieldType,
      description: 'The same field from the other run. One extra lookup per field asked for.',
      resolve: (source, _args, context) => {
        context.resolverCalls += 1;
        const other: Prompt = context.prompt === 'guarded' ? 'naive' : 'guarded';
        const field = context.store.field(other, source.documentId, source.field.key);
        return field ? { field, documentId: source.documentId } : null;
      },
    },
  }),
});

const DocumentType = new GraphQLObjectType<ExtractionDocument, Context>({
  name: 'Document',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    characters: { type: new GraphQLNonNull(GraphQLInt), resolve: (d) => d.text.length },
    text: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The contract verbatim. Spans index into this, so it is never reformatted.',
    },
    ungrounded: {
      type: new GraphQLNonNull(GraphQLInt),
      resolve: (d) => d.fields.filter((f) => f.quote !== null && f.span === null).length,
    },
    fields: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(FieldType))),
      args: { key: { type: GraphQLString } },
      resolve: (doc, args: { key?: string | null }, context) => {
        context.resolverCalls += 1;
        const wanted = args.key ? doc.fields.filter((f) => f.key === args.key) : doc.fields;
        return wanted.map((field) => ({ field, documentId: doc.id }));
      },
    },
  },
});

const VerificationType = new GraphQLObjectType({
  name: 'Verification',
  fields: {
    document: { type: new GraphQLNonNull(GraphQLString) },
    quote: { type: new GraphQLNonNull(GraphQLString) },
    grounded: { type: new GraphQLNonNull(GraphQLBoolean) },
    span: { type: SpanType },
    occurrences: { type: new GraphQLNonNull(GraphQLInt) },
    passage: { type: GraphQLString },
  },
});

const RunType = new GraphQLObjectType({
  name: 'Run',
  fields: {
    prompt: { type: new GraphQLNonNull(GraphQLString) },
    model: { type: new GraphQLNonNull(GraphQLString) },
    calls: { type: new GraphQLNonNull(GraphQLInt) },
    input_tokens: { type: new GraphQLNonNull(GraphQLInt) },
    output_tokens: { type: new GraphQLNonNull(GraphQLInt) },
    seconds: { type: new GraphQLNonNull(GraphQLInt), resolve: (r: { seconds: number }) => Math.round(r.seconds) },
    ungrounded_quotes: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

export const schema = new GraphQLSchema({
  query: new GraphQLObjectType<unknown, Context>({
    name: 'Query',
    fields: {
      runs: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RunType))),
        resolve: (_source, _args, context) => [
          context.store.bundle('guarded').run,
          context.store.bundle('naive').run,
        ],
      },
      documents: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DocumentType))),
        resolve: (_source, _args, context) => {
          context.resolverCalls += 1;
          return context.store.bundle(context.prompt).documents;
        },
      },
      document: {
        type: DocumentType,
        args: { id: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (_source, args: { id: string }, context) => {
          context.resolverCalls += 1;
          return context.store.document(context.prompt, args.id) ?? null;
        },
      },
      verify: {
        type: new GraphQLNonNull(VerificationType),
        description: 'Is this passage actually in the contract? Answers about quotations the model just produced.',
        args: {
          document: { type: new GraphQLNonNull(GraphQLString) },
          quote: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: (_source, args: { document: string; quote: string }, context) => {
          context.resolverCalls += 1;
          return context.store.verify(context.prompt, args.document, args.quote);
        },
      },
    },
  }),
});

/** Nesting allowed before a query is refused. Six clears every shape this schema is for
 *  (`documents { fields { comparison { span { start } } } }` is five) and stops the
 *  unbounded `comparison` recursion, which is the one cycle in the graph. */
export const MAX_DEPTH = 6;

/** Rough cost: one point per selected field, multiplied by the fan-out of the list fields
 *  above it. Not an accounting system -- the point is that a fixed-shape REST route needs
 *  no such rule at all, and a graph does. */
export const MAX_COST = 2000;

function depthOf(node: ASTNode, depth = 0): number {
  if (!('selectionSet' in node) || !node.selectionSet) return depth;
  return Math.max(
    ...node.selectionSet.selections.map((selection) =>
      selection.kind === Kind.FIELD ? depthOf(selection, depth + 1) : depth,
    ),
  );
}

function costOf(node: ASTNode, multiplier = 1): number {
  if (!('selectionSet' in node) || !node.selectionSet) return 0;
  let cost = 0;
  for (const selection of node.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) continue;
    // The list-returning fields are the ones that multiply. Hard-coded rather than
    // inferred from the schema, so the estimate stays readable.
    const fanout = ['documents', 'fields'].includes(selection.name.value) ? 10 : 1;
    cost += multiplier + costOf(selection, multiplier * fanout);
  }
  return cost;
}

export function limitRule(context: ValidationContext) {
  return {
    OperationDefinition(operation: Parameters<typeof depthOf>[0]) {
      const depth = depthOf(operation);
      if (depth > MAX_DEPTH) {
        context.reportError(
          new GraphQLError(`query is ${depth} levels deep; the limit is ${MAX_DEPTH}`, {
            extensions: { code: 'DEPTH_LIMIT_EXCEEDED', depth, limit: MAX_DEPTH },
          }),
        );
      }
      const cost = costOf(operation);
      if (cost > MAX_COST) {
        context.reportError(
          new GraphQLError(`query costs about ${cost}; the limit is ${MAX_COST}`, {
            extensions: { code: 'COST_LIMIT_EXCEEDED', cost, limit: MAX_COST },
          }),
        );
      }
    },
  };
}

export interface GraphQLOutcome {
  /** The HTTP status the transport should use. 400 only for a request that never ran. */
  status: number;
  body: { data?: unknown; errors?: readonly unknown[]; extensions?: Record<string, unknown> };
  resolverCalls: number;
}

/**
 * Run one query.
 *
 * Validation failures return 400 because nothing executed. Runtime failures return **200
 * with an errors array**, which is the specification's behaviour and the trap: the
 * response is a success at the transport layer and a failure at the application layer, and
 * only one of those two is on a dashboard by default.
 */
export async function run(
  store: Store,
  source: string,
  options: { prompt?: Prompt; variables?: Record<string, unknown> } = {},
): Promise<GraphQLOutcome> {
  const context: Context = { store, prompt: options.prompt ?? 'guarded', resolverCalls: 0 };

  let ast;
  try {
    ast = parse(source);
  } catch (cause) {
    return { status: 400, body: { errors: [cause] }, resolverCalls: 0 };
  }

  const problems = validate(schema, ast, [...specifiedRules, limitRule]);
  if (problems.length > 0) {
    return { status: 400, body: { errors: [...problems] }, resolverCalls: 0 };
  }

  const result = await execute({
    schema,
    document: ast,
    contextValue: context,
    variableValues: options.variables,
  });

  return {
    status: 200,
    body: {
      ...result,
      // Reported back so the N+1 is visible to whoever is looking at the response rather
      // than only to the test suite.
      extensions: { resolverCalls: context.resolverCalls },
    },
    resolverCalls: context.resolverCalls,
  };
}
