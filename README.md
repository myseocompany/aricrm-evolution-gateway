# Evolution webhook gateway

Durable ingress between Evolution and AriCRM, implemented with Node.js 22, TypeScript and Fastify. The service persists each authenticated JSON payload in PostgreSQL before returning `200`, deduplicates exact retries, and forwards asynchronously with bounded concurrency. Persistence failure returns `503` so Evolution can retry.

Production currently has one pilot instance behind the gateway. Do not migrate every Evolution instance at once. Review [PRODUCTION_ROLLOUT.md](PRODUCTION_ROLLOUT.md) for the audited inventory, known limitations, rollout gates and rollback procedure.

> The current MVP preserves the JSON value, but not the original request bytes: Fastify parses the body, PostgreSQL stores it as `JSONB`, and the worker serializes it again. Code and documentation must not claim byte-for-byte transparency until raw-body storage and delivery are implemented and tested.

## Deployment

1. Copy this directory to `/opt/aricrm-gateway`.
2. Create `.env` from `.env.example` with independent random secrets; mode `600`.
3. Point `hooks.aricrm.co` to the gateway IPv4/IPv6.
4. Run `docker compose up -d --build`.
5. Verify `https://hooks.aricrm.co/healthz` and perform a sanitized duplicate/retry test.

Evolution URL format:

```text
https://hooks.aricrm.co/v1/evolution?token=<INGRESS_TOKEN>
```

Do not log URLs containing tokens. A `401`/`403` from AriCRM sends that event to DLQ and opens a five-minute circuit breaker.

## Operations

`/metrics` is intentionally not public: it requires the independent `METRICS_TOKEN` in
the `X-Gateway-Metrics-Token` header. It returns only aggregate queue state, pending
age and circuit state; it never returns payloads or secrets.

`monitor.sh` is intended to run with the included systemd timer. It checks pending age,
DLQ size and Docker disk use each minute, writes alerts to syslog and can optionally
POST a small JSON alert to `ALERT_WEBHOOK_URL`. Install it only on the gateway host:

```text
install -m 700 monitor.sh /usr/local/sbin/aricrm-gateway-monitor
install -m 644 systemd/aricrm-gateway-monitor.service /etc/systemd/system/
install -m 644 systemd/aricrm-gateway-monitor.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now aricrm-gateway-monitor.timer
```

The gateway is a transparent transport: it must not resolve LID/PN or alter identities
or payload contents.
