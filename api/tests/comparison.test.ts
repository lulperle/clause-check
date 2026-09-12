/**
 * The README makes claims about how the three interfaces differ. This file asserts those
 * claims against the committed measurement, so a change that reverses a finding fails here
 * instead of leaving the README quietly wrong.
 *
 * Every expectation below is a *direction*, not a byte count: 295 versus 429 is this data
 * set on this day, and pinning it would produce a test that fails whenever a contract is
 * reworded. What must not change is which side is smaller and why.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ROOT } from './harness';

const comparison = JSON.parse(readFileSync(`${ROOT}/api/comparison.json`, 'utf-8'));
const task = (needle: string) =>
  comparison.tasks.find((t: { task: string }) => t.task.includes(needle));
const failure = (needle: string) =>
  comparison.errors.find((e: { failure: string }) => e.failure.includes(needle));

describe('the measured comparison', () => {
  it('covers three tasks and four failures across all three interfaces', () => {
    expect(comparison.tasks).toHaveLength(3);
    expect(comparison.errors).toHaveLength(4);
    for (const entry of [...comparison.tasks, ...comparison.errors]) {
      expect(Object.keys(entry)).toEqual(expect.arrayContaining(['rest', 'graphql', 'mcp']));
    }
  });

  it('shows GraphQL sending less for a screen that needs two fields out of five', () => {
    const tabs = task('tab bar');
    expect(tabs.graphql.bytes).toBeLessThan(tabs.rest.bytes);
  });

  it('shows the envelope costs almost nothing once the field sets are equal', () => {
    // The honest half of the over-fetching claim. Asking GraphQL for everything REST
    // returns lands within a few percent, so GraphQL's win is not a more efficient
    // protocol -- it is the ability to leave fields out.
    const screen = task('review screen');
    const envelope = Math.abs(screen.rest.bytes - screen.graphql.bytes_same_fields);
    expect(envelope / screen.rest.bytes).toBeLessThan(0.05);
    expect(screen.graphql.bytes_same_fields - screen.graphql.bytes).toBeGreaterThan(1000);
  });

  it('shows GraphQL collapsing two REST round trips into one', () => {
    const ask = task('agent question');
    expect(ask.rest.round_trips).toBe(2);
    expect(ask.graphql.round_trips).toBe(1);
    expect(ask.mcp.round_trips).toBe(2);
  });

  it('shows MCP as the most expensive per call on every task, which is the trade it makes', () => {
    // Pretty-printed JSON and prose error messages, both deliberate: the consumer is a
    // model, and the cost buys a call it can get right the first time.
    for (const entry of comparison.tasks) {
      expect(entry.mcp.bytes).toBeGreaterThan(entry.graphql.bytes);
    }
  });

  it('shows REST answering 404 for both kinds of missing thing', () => {
    expect(failure('document id that does not exist').rest.status).toBe(404);
    expect(failure('field that does not exist').rest.status).toBe(404);
  });

  it('shows GraphQL reporting a missing document as a successful null', () => {
    // The one I would raise in a design review: without a convention (a union, or an error
    // extension) a caller cannot tell "no such contract" from "this contract has no title".
    const missing = failure('document id that does not exist');
    expect(missing.graphql.status).toBe(200);
    expect(missing.graphql.errors).toBeNull();
    expect(missing.graphql.data).toEqual({ document: null });
  });

  it('shows GraphQL catching a misspelled field before execution, where REST cannot', () => {
    expect(failure('field that does not exist').graphql.status).toBe(400);
  });

  it('shows a runtime failure arriving as a 200 with an errors array', () => {
    const thrown = failure('non-null');
    expect(thrown.graphql.status).toBe(200);
    expect(thrown.graphql.errors).not.toBeNull();
    expect(thrown.graphql.data).toBeNull();
  });

  it('shows every interface treating an absent quotation as an answer', () => {
    const absent = failure('quotation that is not in the contract');
    expect(absent.rest.status).toBe(200);
    expect(absent.rest.body.grounded).toBe(false);
    expect(absent.graphql.errors).toBeNull();
    expect(absent.mcp.isError).toBe(false);
  });

  it('shows MCP naming the alternatives in its error text', () => {
    for (const label of ['document id that does not exist', 'field that does not exist']) {
      expect(failure(label).mcp.isError).toBe(true);
      expect(failure(label).mcp.text.length).toBeGreaterThan(40);
    }
  });

  it('shows one small query fanning out into dozens of resolver calls', () => {
    expect(comparison.graph_costs.fanout_resolver_calls).toBeGreaterThan(30);
    // Small on the wire, expensive on the server: the asymmetry that makes a cost limit
    // necessary in a way it never is for a fixed REST route.
    expect(comparison.graph_costs.fanout_bytes).toBeLessThan(8000);
    expect(comparison.graph_costs.rejected_status).toBe(400);
    expect(comparison.graph_costs.rejected_because[0]).toContain('levels deep');
  });

  it('records what an MCP session pays before any tool is called', () => {
    expect(comparison.mcp_session_cost.tools).toBe(5);
    expect(comparison.mcp_session_cost.description_bytes).toBeGreaterThan(1000);
  });
});
