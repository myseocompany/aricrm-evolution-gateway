import assert from 'node:assert/strict';
import test from 'node:test';
import { createCircuitBreaker, buildOutgoingHeaders, deliverHttp, type EgressConfig } from '../src/egress.js';

test('circuit breaker opens and resets', () => {
    const cb = createCircuitBreaker(1000);
    assert.equal(cb.isOpen(), false);
    cb.open();
    assert.equal(cb.isOpen(), true);
    cb.reset();
    assert.equal(cb.isOpen(), false);
});

test('circuit breaker auto-expires', async () => {
    const cb = createCircuitBreaker(50);
    cb.open();
    assert.equal(cb.isOpen(), true);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(cb.isOpen(), false);
});

test('buildOutgoingHeaders includes content-type', () => {
    const headers = buildOutgoingHeaders();
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['user-agent'], undefined);
});

test('buildOutgoingHeaders merges extra headers', () => {
    const headers = buildOutgoingHeaders({ 'user-agent': 'test/1.0', 'x-custom': 'yes' });
    assert.equal(headers['user-agent'], 'test/1.0');
    assert.equal(headers['x-custom'], 'yes');
});

test('deliverHttp returns circuit_open when breaker is open', async () => {
    const cb = createCircuitBreaker(60_000);
    cb.open();
    const config: EgressConfig = {
        targetUrl: 'http://127.0.0.1:1', // unreachable, but won't be called
        timeoutMs: 1000,
        maxAttempts: 3,
        userAgent: 'test/1.0',
        maxResponseBytes: 1024,
        circuitBreakerSeconds: 60,
    };
    const result = await deliverHttp({}, config, cb);
    assert.equal(result.kind, 'retry');
    assert.equal(result.reason, 'circuit_open');
    assert.equal(result.latencyMs, 0);
});

test('deliverHttp classifies 200 as delivered', async () => {
    // Start a minimal HTTP server to respond 200
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;

    const config: EgressConfig = {
        targetUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 2000,
        maxAttempts: 3,
        userAgent: 'test/1.0',
        maxResponseBytes: 1024,
        circuitBreakerSeconds: 300,
    };
    const cb = createCircuitBreaker(300_000);
    const result = await deliverHttp({ event: 'test' }, config, cb);

    assert.equal(result.kind, 'delivered');
    assert.equal(result.status, 200);
    assert.equal(result.reason, 'ok');
    assert.ok(result.latencyMs >= 0);

    server.close();
});

test('deliverHttp classifies 401 as auth_dead and opens circuit', async () => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const server = createServer((_req, res) => {
        res.writeHead(401);
        res.end('Unauthorized');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;

    const config: EgressConfig = {
        targetUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 2000,
        maxAttempts: 3,
        userAgent: 'test/1.0',
        maxResponseBytes: 1024,
        circuitBreakerSeconds: 300,
    };
    const cb = createCircuitBreaker(300_000);
    assert.equal(cb.isOpen(), false);
    const result = await deliverHttp({}, config, cb);

    assert.equal(result.kind, 'auth_dead');
    assert.equal(result.status, 401);
    assert.equal(cb.isOpen(), true);

    server.close();
});

test('deliverHttp returns target_unreachable on connection refused', async () => {
    const config: EgressConfig = {
        targetUrl: 'http://127.0.0.1:1', // port 1 — nothing listening
        timeoutMs: 1000,
        maxAttempts: 3,
        userAgent: 'test/1.0',
        maxResponseBytes: 1024,
        circuitBreakerSeconds: 300,
    };
    const cb = createCircuitBreaker(300_000);
    const result = await deliverHttp({}, config, cb);

    assert.equal(result.kind, 'retry');
    assert.equal(result.reason, 'target_unreachable');
    assert.equal(result.status, null);
});