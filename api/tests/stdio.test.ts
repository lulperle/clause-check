/**
 * The MCP server as a client actually launches it: a spawned process speaking JSON-RPC over
 * stdio.
 *
 * The other MCP tests use an in-memory transport and would pass even if this never started.
 * The failure this catches is specific and easy to cause: anything written to stdout that
 * is not a protocol frame corrupts the stream, so one stray `console.log` -- in this file's
 * code or in a dependency -- breaks every client while every other test stays green.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

import { ROOT } from './harness';

describe('the MCP server as a launched process', () => {
  it('starts over stdio and answers a tool call', async () => {
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({ command: 'npx', args: ['tsx', 'api/mcp.ts'], cwd: ROOT }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('verify_quote');

      const result = await client.callTool({
        name: 'verify_quote',
        arguments: { id: 'saas-riyo', quote: '本契約は無期限に自動更新される' },
      });
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.grounded).toBe(false);
    } finally {
      await client.close();
    }
    // Spawning node twice through npx is slow, and this is the only test that does it.
  }, 60_000);
});
