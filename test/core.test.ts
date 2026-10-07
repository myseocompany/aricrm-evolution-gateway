import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyStatus, deliveryReason, eventKey, retryDelayMs, secureEqual } from '../src/core.js';

test('event key is stable and payload-sensitive', () => {
    const a = {
        event: 'messages.upsert',
        instance: 'line_a',
        data: {
            key: {
                id: 'm1'
            }
        }
    };

    const b = {
        event: 'messages.upsert',
        instance: 'line_a',
        data: {
            key: {
                id: 'm2'
            }
        }
    };

    assert.equal(eventKey(a, JSON.stringify(a)),
        eventKey(a, JSON.stringify(a)));

    assert.notEqual(eventKey(a, JSON.stringify(a)),
        eventKey(b, JSON.stringify(b)));
});

test('status classification', () => {
    assert.equal(classifyStatus(200), 'delivered');
    assert.equal(classifyStatus(429), 'retry');
    assert.equal(classifyStatus(503), 'retry');
    assert.equal(classifyStatus(401), 'auth_dead');
    assert.equal(classifyStatus(403), 'auth_dead');
    assert.equal(classifyStatus(422), 'dead');
});

test('delivery reason', () => {
    assert.equal(deliveryReason('delivered', 200), 'ok');
    assert.equal(deliveryReason('auth_dead', 401), 'target_auth_rejected');
    assert.equal(deliveryReason('retry', null), 'target_unreachable');
    assert.equal(deliveryReason('dead', 422), 'target_error');
});

test('retry and token helpers', () => {
    assert.equal(retryDelayMs(1, .5), 1000);
    assert.ok(retryDelayMs(30, 1) <= 1_080_000);
    assert.equal(secureEqual('abcdefghijklmnopqrstuvwxyz123456', 'abcdefghijklmnopqrstuvwxyz123456'), true);
    assert.equal(secureEqual('abcdefghijklmnopqrstuvwxyz123456', 'different'), false);
});
