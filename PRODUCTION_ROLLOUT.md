# Production rollout audit

Audit date: 2026-09-22

## Decision

Do not migrate all Evolution tenants to the gateway in one operation.

The gateway is live and the single pilot is working, but the current MVP lacks the capacity evidence and isolation controls required for a full cutover. Migrate in measured batches only after the blocking items below are resolved.

## Observed production state

Evolution runs on `204.168.163.168`. The gateway is published as `https://hooks.aricrm.co` on a separate host, and its public `/healthz` endpoint returned `200` during this audit.

The Evolution database contained 39 instances:

| Webhook destination | Instances | State |
|---|---:|---|
| Direct to `https://app.aricrm.co` | 36 | Not migrated |
| `https://hooks.aricrm.co` | 1 | Pilot |
| No webhook | 2 | `main` and `test-tenant`; webhook disabled |

Pilot: `line_56e08751ac91`, connected, webhook enabled, five subscribed events.

During the Waterfall incident, Hetzner generated approximately 85,970 direct `POST /index.php` requests in one day. The observed rate was roughly 40–180 requests/minute, and individual AriCRM responses took about 0.4–1.5 seconds. Waterfall has two vCPUs and was CPU-saturated. This is the load path the gateway must absorb and smooth.

## What the MVP currently guarantees

- Authenticates ingress with a shared token.
- Stores the parsed JSON in its own PostgreSQL database before acknowledging it.
- Returns `503` if persistence fails.
- Deduplicates exact equivalent JSON events using a hash-derived key.
- Delivers asynchronously with configurable worker concurrency.
- Retries `429` and `5xx` responses with exponential backoff and jitter.
- Sends other non-authentication `4xx` responses to dead-letter state.
- Opens an in-memory five-minute circuit after a `401` or `403` from AriCRM.
- Exposes authenticated aggregate metrics and includes a local monitoring timer.

## Blocking findings before broad migration

1. **The global ingress limit can recreate a retry storm.** Fastify currently limits the whole service to 600 requests/minute. Requests rejected with `429` have not been persisted, and Evolution may retry them. Health and metrics also share this global limiter. Replace this with a capacity policy that persists accepted events and does not use ordinary `429` responses as the main flow-control mechanism.

2. **No per-tenant isolation.** All instances share one ingress token, one queue and one worker pool. A noisy tenant can consume gateway capacity for every tenant. Add at least per-source credentials/identity, measurable per-source usage and fair delivery scheduling before full rollout.

3. **No production capacity test for 39 instances.** Four workers can deliver at most approximately 160–600 requests/minute at the observed AriCRM latency, before accounting for retries and database overhead. Run a sustained test plus a burst test using sanitized payloads and record CPU, database growth, pending age and drain time.

4. **Payloads are not byte-for-byte transparent.** The request is parsed, stored as `JSONB` and serialized again. JSON semantics are retained, but original bytes, formatting and key order are not. Either change the contract to semantic JSON transparency or store and forward the raw body.

5. **AriCRM has no gateway delivery idempotency contract.** The worker does not send a trusted gateway event ID, and AriCRM does not reserve that ID before dispatching work. A timeout after AriCRM commits can therefore cause duplicate domain processing even when gateway ingress deduplication works.

6. **The circuit breaker is global and in memory.** One authentication failure pauses every tenant, and a process restart clears the circuit. Persist destination state or explicitly document and monitor this limitation.

7. **The repository is not versioned.** At audit time the `main` branch had no commits and every project file was untracked. Create the baseline commit and tag the exact version deployed before changing production traffic.

8. **Operational verification is incomplete from this workstation.** Public health was verified, but SSH access to the gateway host was unavailable during the audit, so live pending count, DLQ, disk state and timer status could not be independently reconfirmed. Do not expand the pilot until those checks pass.

## Required production gates

All gates must be green before each batch:

- Public and internal health checks pass.
- PostgreSQL backup and restore procedure has been exercised.
- Pending age is below 60 seconds during normal traffic.
- DLQ is empty or every entry has an explained disposition.
- Disk usage is below 70%, with retention confirmed.
- Gateway host CPU and memory remain below 60% during the observation window.
- AriCRM `5xx`, `429`, p95 latency and PHP-FPM saturation do not regress.
- Evolution attempts, gateway accepted/duplicate counts and AriCRM accepted counts reconcile by event type.
- The previous Evolution webhook configuration is backed up securely for every migrated instance.
- A named operator can perform rollback without consulting application secrets in logs or shell history.

## Recommended rollout

### Phase 0 — harden and baseline

Resolve findings 1, 2, 5 and 7. Obtain gateway-host access and record baseline metrics for at least 24 hours with the existing pilot.

### Phase 1 — three low-volume instances

Select three connected, low-volume lines from different tenants. Change only their webhook destination and credential. Observe for 24 hours. Roll back the batch if pending age exceeds five minutes, any unexplained DLQ appears, or AriCRM message counts fail reconciliation.

### Phase 2 — batches of five

Migrate five instances at a time, never two batches inside the same 24-hour observation window. Prefer low/medium volume first. Record before/after request rates on Waterfall and gateway drain time.

### Phase 3 — high-volume tenants

Move the noisiest tenants only after a burst test demonstrates at least twice their measured peak rate while maintaining the pending-age objective. Migrate each high-volume tenant individually.

### Phase 4 — close direct ingress

After all active instances have passed reconciliation and a final 48-hour observation window, restrict the AriCRM Evolution endpoint so only the gateway can invoke it. Keep an explicit, tested emergency rollback path; do not leave an undocumented bypass.

The two webhook-less instances (`main`, `test-tenant`) are not migration candidates unless they are deliberately reactivated and assigned to a real tenant.

## Per-instance migration checklist

1. Confirm the Evolution instance maps to the intended AriCRM tenant and line.
2. Record connection state, enabled events and the current destination in a restricted backup. Never place tokens in this document or command output.
3. Create a unique gateway source credential once per-source authentication exists.
4. Set the destination to `https://hooks.aricrm.co/v1/evolution` and supply authentication through a header when supported; avoid query-string secrets.
5. Send one controlled inbound and one outbound message.
6. Confirm Evolution emitted the events, the gateway persisted and delivered them, and AriCRM materialized each message exactly once.
7. Check pending age, DLQ, gateway errors, Waterfall latency and PHP-FPM load.
8. Start the observation window and record the operator, timestamp and rollback reference.

## Rollback

Rollback is per instance or per batch, not global by default:

1. Restore the saved direct AriCRM webhook configuration for the affected instances.
2. Stop adding new instances to the gateway.
3. Preserve the gateway database; do not delete pending or dead events.
4. Decide whether pending events should drain, be exported or be marked terminal only after comparing them with AriCRM processing records.
5. Reconcile messages and status updates created during the transition to prevent duplicate delivery.
6. Document the trigger, affected instances, event counts and final disposition.

## Verification commands

Run these on the gateway host from `/opt/aricrm-gateway`; they intentionally avoid printing secrets:

```bash
docker compose ps
systemctl is-active aricrm-gateway-monitor.timer
docker compose exec -T postgres psql -U gateway -d gateway -P pager=off -c \
  "select state, count(*), min(created_at) as oldest from webhook_events group by state order by state;"
docker compose exec -T postgres psql -U gateway -d gateway -P pager=off -c \
  "select count(*) as pending_over_5m from webhook_events where state='pending' and created_at < now() - interval '5 minutes';"
```

Never print `.env`, full webhook URLs, request headers or payloads during verification.
