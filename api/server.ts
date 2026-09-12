/**
 * One `node:http` server carrying both HTTP interfaces, so the comparison in the README is
 * not confounded by two different servers on two different runtimes.
 *
 * `POST /graphql` and everything else REST. GraphQL takes POST only: a GET with the query
 * in the URL is cacheable, which sounds like an advantage until a query string long enough
 * to matter meets a proxy's URL length limit, and this API has nothing to cache anyway.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { run as runGraphQL } from './graphql';
import { handle as handleREST } from './rest';
import { openStore, type Prompt, type Store } from './store';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createApi(store: Store = openStore()): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname !== '/graphql') {
      handleREST(store, req, res);
      return;
    }

    if (req.method !== 'POST') {
      send(res, 405, { error: 'method_not_allowed', detail: 'POST a JSON body of {"query": "…"}' });
      return;
    }

    void readBody(req).then(async (body) => {
      let request: { query?: unknown; variables?: unknown; prompt?: unknown };
      try {
        request = JSON.parse(body || '{}');
      } catch {
        send(res, 400, { errors: [{ message: 'the request body is not JSON' }] });
        return;
      }
      if (typeof request.query !== 'string') {
        send(res, 400, { errors: [{ message: 'body must be {"query": "…"}' }] });
        return;
      }
      const outcome = await runGraphQL(store, request.query, {
        prompt: request.prompt === 'naive' ? 'naive' : ('guarded' satisfies Prompt),
        variables: (request.variables ?? undefined) as Record<string, unknown> | undefined,
      });
      send(res, outcome.status, outcome.body);
    });
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  createApi().listen(port, () => {
    process.stdout.write(`clause-check api on http://localhost:${port}\n`);
  });
}
