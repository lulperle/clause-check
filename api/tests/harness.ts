/**
 * A real server on a real port for the HTTP tests.
 *
 * A faked request object would be faster and would test less: `content-length`, the status
 * line, method routing and JSON encoding are all part of what these two interfaces *are*,
 * and a fake that satisfies the handler proves the handler satisfies the fake. Port 0 lets
 * the OS pick, so the tests can run in parallel.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApi } from '../server';
import { openStore, type Store } from '../store';

/** Parsed JSON, typed loosely on purpose: a test that has to satisfy a type before it can
 *  assert on the payload ends up asserting the type instead of the payload. */
type Json = Record<string, any>;

export interface Response_ {
  status: number;
  body: Json;
  bytes: number;
  headers: Headers;
}

export interface Api {
  get(path: string): Promise<Response_>;
  post(path: string, body: unknown): Promise<Response_>;
  graphql(query: string, options?: { prompt?: string; variables?: unknown }): Promise<Response_>;
  close(): Promise<void>;
}

/** The repository root, wherever vitest was started from. */
export const ROOT = new URL('../..', import.meta.url).pathname;

export function store(): Store {
  return openStore(ROOT);
}

export async function start(): Promise<Api> {
  const server: Server = createApi(store());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const read = async (response: Response) => {
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      bytes: Buffer.byteLength(text),
      headers: response.headers,
    };
  };

  return {
    get: async (path) => read(await fetch(`${base}${path}`)),
    post: async (path, body) =>
      read(
        await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    graphql: async (query, options = {}) =>
      read(
        await fetch(`${base}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, ...options }),
        }),
      ),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
