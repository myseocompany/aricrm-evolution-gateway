// src/egress.ts — Egress: delivery logic extracted from server.ts
// Separates HTTP delivery concerns from the ingress/worker orchestrator.

import { classifyStatus, retryDelayMs } from './core.js';

export interface EgressConfig {
    targetUrl: string;
    timeoutMs: number;
    maxAttempts: number;
    userAgent: string;
    maxResponseBytes: number;
    circuitBreakerSeconds: number;
}

export interface DeliveryResult {
    kind: 'delivered' | 'retry' | 'auth_dead' | 'dead';
    status: number | null;
    reason: string;
    latencyMs: number;
}

export interface CircuitState {
    open: boolean;
    until: number;
}

// single-destination circuit breaker. Per-destination map when multi-tenant routing is added.
export function createCircuitBreaker(durationMs: number) {
    let until = 0;
    return {
        isOpen(): boolean { return Date.now() < until; },
        open(): void { until = Date.now() + durationMs; },
        reset(): void { until = 0; },
        state(): CircuitState { return { open: Date.now() < until, until }; },
    };
}

export function buildOutgoingHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    };
    // no header forwarding yet. When Evolution sends custom headers
    // that AriCRM needs (e.g. X-Evolution-Instance), forward them here.
    if (extra) Object.assign(headers, extra);
    return headers;
}

export async function deliverHttp(
    payload: unknown,
    config: EgressConfig,
    circuit: ReturnType<typeof createCircuitBreaker>,
    signal?: AbortSignal,
): Promise<DeliveryResult> {
    if (circuit.isOpen()) {
        return { kind: 'retry', status: null, reason: 'circuit_open', latencyMs: 0 };
    }

    const start = Date.now();
    try {
        const response = await fetch(config.targetUrl, {
            method: 'POST',
            headers: buildOutgoingHeaders({ 'user-agent': config.userAgent }),
            body: JSON.stringify(payload),
            signal: signal ?? AbortSignal.timeout(config.timeoutMs),
        });

        // Drain response body up to maxResponseBytes for observability.
        // we don't use the body yet, but draining prevents connection leaks.
        const reader = response.body?.getReader();
        if (reader) {
            let bytesRead = 0;
            while (bytesRead < config.maxResponseBytes) {
                const { done, value } = await reader.read();
                if (done) break;
                bytesRead += value.byteLength;
            }
            reader.releaseLock();
        }

        const latencyMs = Date.now() - start;
        const kind = classifyStatus(response.status);

        if (kind === 'auth_dead') circuit.open();

        return {
            kind,
            status: response.status,
            reason: kind === 'delivered' ? 'ok'
                : kind === 'auth_dead' ? 'target_auth_rejected'
                    : 'target_error',
            latencyMs,
        };
    } catch (error) {
        const latencyMs = Date.now() - start;
        const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
        return {
            kind: 'retry',
            status: null,
            reason: isTimeout ? 'target_timeout' : 'target_unreachable',
            latencyMs,
        };
    }
}