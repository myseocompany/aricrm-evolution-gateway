/**
 * Analyzer detection tests using synthetic fixtures.
 *
 * local_analysis is a faithful TypeScript port of the Python function in
 * aripulse/scripts/botanazo_analysis/analyze.py. This lets the gateway
 * validate expected detections without a Python dependency.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtures, SILENCE_THRESHOLD_MINUTES, type Message, type ExpectedDetection } from './synthetic-fixtures.js';

// Port of analyze.py → local_analysis

interface LocalFinding {
  candidate: boolean;
  signals: string[];
  last_direction: string | null;
  first_response_minutes: number | null;
  max_inbound_wait_minutes: number | null;
  message_count: number;
}

/** Round to two decimal places, matching Python's round(x, 2). */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minutes between two Dates, floored at 0. */
const minutesBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);

function localAnalysis(messages: Message[], silenceMinutes: number): LocalFinding {
  const ordered = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  let firstInboundAt: Date | null = null;
  let firstOutboundAfterInbound: Date | null = null;
  let pendingInboundAt: Date | null = null;
  const waits: number[] = [];

  for (const { timestamp, direction } of ordered) {
    const at = new Date(timestamp);

    if (direction === 'in') {
      firstInboundAt ??= at;
      pendingInboundAt ??= at;
    } else if (direction === 'out' && pendingInboundAt) {
      waits.push(minutesBetween(pendingInboundAt, at));
      firstOutboundAfterInbound ??= at;
      pendingInboundAt = null;
    }
  }

  const lastDirection = ordered.at(-1)?.direction ?? null;
  const unanswered = lastDirection === 'in';
  const longWait = waits.length > 0 && Math.max(...waits) >= silenceMinutes;

  const signals: string[] = [];
  if (unanswered) signals.push('unanswered_inbound');
  if (longWait) signals.push('response_gap_over_threshold');

  const firstResponse = firstInboundAt && firstOutboundAfterInbound
    ? round2(minutesBetween(firstInboundAt, firstOutboundAfterInbound))
    : null;

  return {
    candidate: unanswered || longWait,
    signals,
    last_direction: lastDirection,
    first_response_minutes: firstResponse,
    max_inbound_wait_minutes: waits.length > 0 ? round2(Math.max(...waits)) : null,
    message_count: ordered.length,
  };
}

// Assertions

function assertFindingMatches(actual: LocalFinding, expected: ExpectedDetection, label: string) {
  assert.equal(actual.candidate, expected.candidate, `${label} candidate`);
  assert.deepEqual(actual.signals, expected.signals, `${label} signals`);
  assert.equal(actual.last_direction, expected.last_direction, `${label} last_direction`);
  assert.equal(actual.first_response_minutes, expected.first_response_minutes, `${label} first_response_minutes`);
  assert.equal(actual.max_inbound_wait_minutes, expected.max_inbound_wait_minutes, `${label} max_inbound_wait_minutes`);
  assert.equal(actual.message_count, expected.message_count, `${label} message_count`);
}

// Tests

for (const { id, category, conversation, expected } of fixtures) {
  test(`analyzer: ${id} (${category})`, () => {
    const result = localAnalysis(conversation.messages, SILENCE_THRESHOLD_MINUTES);
    assertFindingMatches(result, expected, id);
  });
}

test('analyzer: all four categories are covered', () => {
  const categories = new Set(fixtures.map(f => f.category));
  for (const required of ['unanswered', 'answered', 'delayed-response', 'ambiguous'] as const) {
    assert.ok(categories.has(required), `${required} case missing`);
  }
});

test('analyzer: no fixture contains PII fields', () => {
  const CONTRACT_KEYS = ['actor', 'direction', 'text', 'timestamp'] as const;
  for (const { id, conversation } of fixtures) {
    assert.ok(conversation.conversation_id.startsWith('syn-'), `${id}: non-synthetic conversation_id`);
    for (const msg of conversation.messages) {
      assert.deepEqual(Object.keys(msg).sort(), [...CONTRACT_KEYS].sort(), `${id}: extra message fields`);
    }
  }
});
