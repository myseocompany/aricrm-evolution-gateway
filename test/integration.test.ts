import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const execDocker = async (...args: string[]) => (await execFile('docker', args, { encoding: 'utf8' })).stdout.trim();
const ingressToken = 'integration-ingress-token-1234567890';
const metricsToken = 'integration-metrics-token-1234567890';
const root = new URL('..', import.meta.url).pathname;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await sleep(150); }
  throw new Error('timed out waiting for gateway condition');
}
async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port; server.close(); return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
type Gateway = { child: ChildProcess; baseUrl: string; output: () => string };
async function startGateway(port: number, databaseUrl: string, targetUrl: string, workers = 1): Promise<Gateway> {
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, TARGET_URL: targetUrl, INGRESS_TOKEN: ingressToken, METRICS_TOKEN: metricsToken, EGRESS_USER_AGENT: 'integration-test/1.0', TARGET_TIMEOUT_SECONDS: '1', WORKERS: String(workers), MAX_ATTEMPTS: '3' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', data => { output += data; }); child.stderr?.on('data', data => { output += data; });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${baseUrl}/healthz`)).status === 200; }
      catch { return false; }
    });
  }
  catch (error) { await stop(child); throw new Error(`gateway did not start: ${output}`, { cause: error }); }
  return { child, baseUrl, output: () => output };
}

test('integration: transparent durable failure policies', { timeout: 60_000 }, async (t) => {
  try { await execDocker('version', '--format', '{{.Server.Version}}'); }
  catch { t.skip('Docker is required for PostgreSQL integration tests'); return; }

  const name = `aricrm-gateway-it-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  let gateway: Gateway | undefined; let target: Server | undefined;
  const hits = new Map<string, number>();
  try {
    await execDocker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_DB=gateway', '-e', 'POSTGRES_USER=gateway', '-e', 'POSTGRES_PASSWORD=gateway-test-password', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const portLine = await execDocker('port', name, '5432/tcp');
    const postgresPort = Number(portLine.slice(portLine.lastIndexOf(':') + 1));
    await waitFor(async () => {
      try {
        await execDocker('exec', name, 'psql', '-U', 'gateway', '-d', 'gateway', '-Atqc', 'SELECT 1');
        return true;
      } catch { return false; }
    });
    await sleep(500);
    const databaseUrl = `postgres://gateway:gateway-test-password@127.0.0.1:${postgresPort}/gateway`;
    target = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: { scenario?: string } };
      const scenario = body.data?.scenario ?? 'default'; const count = (hits.get(scenario) ?? 0) + 1; hits.set(scenario, count);
      if (scenario === 'retry' && count === 1) return void response.writeHead(503).end('{}');
      if (scenario === 'timeout' && count === 1) return void setTimeout(() => response.writeHead(200).end('{}'), 1_500);
      if (scenario === 'dead') return void response.writeHead(422).end('{}');
      if (scenario === 'auth401') return void response.writeHead(401).end('{}');
      if (scenario === 'auth403') return void response.writeHead(403).end('{}');
      response.writeHead(200).end('{}');
    });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    gateway = await startGateway(await freePort(), databaseUrl, targetUrl);
    const send = async (scenario: string) => {
      const response = await fetch(`${gateway!.baseUrl}/v1/evolution`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-token': ingressToken }, body: JSON.stringify({ event: 'messages.upsert', instance: 'integration-line', data: { key: { id: scenario }, scenario } }) });
      assert.equal(response.status, 200); return response.json() as Promise<{ id: string }>;
    };
    const metrics = async () => {
      const response = await fetch(`${gateway!.baseUrl}/metrics`, { headers: { 'x-gateway-metrics-token': metricsToken } });
      assert.equal(response.status, 200); return response.json() as Promise<{ events: Record<string, number>; circuitOpen: boolean; pendingAgeSeconds: number; avgLatencyMs: number }>;
    };
    assert.equal((await fetch(`${gateway.baseUrl}/metrics`)).status, 401, 'metrics must be token-protected');
    const a = await send('duplicate'); const b = await send('duplicate'); assert.equal(a.id, b.id, 'same payload is one durable event');
    await waitFor(async () => hits.get('duplicate') === 1 && (await metrics()).events.delivered === 1);
    await send('retry'); await waitFor(async () => hits.get('retry') === 2 && (await metrics()).events.delivered === 2);
    await send('timeout'); await waitFor(async () => hits.get('timeout') === 2 && (await metrics()).events.delivered === 3, 18_000);
    await send('dead'); await waitFor(async () => (await metrics()).events.dead === 1);
    await send('auth401'); await waitFor(async () => (await metrics()).circuitOpen && (await metrics()).events.dead === 2);
    await send('blocked'); await sleep(500); assert.equal(hits.get('blocked') ?? 0, 0, 'open circuit pauses delivery');
    await stop(gateway.child); gateway = await startGateway(await freePort(), databaseUrl, targetUrl);
    await waitFor(async () => hits.get('blocked') === 1);
    await send('auth403'); await waitFor(async () => (await metrics()).circuitOpen && (await metrics()).events.dead === 3);
    assert.equal(hits.get('auth403'), 1, '403 applies the circuit policy');
  } finally {
    if (gateway) await stop(gateway.child);
    if (target) await new Promise<void>(resolve => target!.close(() => resolve()));
    await execDocker('rm', '-f', name).catch(() => undefined);
  }
});

test('migration: adds instance and last_latency_ms to existing schema', { timeout: 30_000 }, async (t) => {
  try { await execDocker('version', '--format', '{{.Server.Version}}'); }
  catch { t.skip('Docker is required for PostgreSQL migration tests'); return; }

  const name = `aricrm-migration-it-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const { Client } = await import('pg');
  try {
    await execDocker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_DB=gateway', '-e', 'POSTGRES_USER=gateway', '-e', 'POSTGRES_PASSWORD=gateway-test-password', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const portLine = await execDocker('port', name, '5432/tcp');
    const postgresPort = Number(portLine.slice(portLine.lastIndexOf(':') + 1));
    await waitFor(async () => {
      try { await execDocker('exec', name, 'psql', '-U', 'gateway', '-d', 'gateway', '-Atqc', 'SELECT 1'); return true; }
      catch { return false; }
    });
    await sleep(500);
    const client = new Client(`postgres://gateway:gateway-test-password@127.0.0.1:${postgresPort}/gateway`);
    await client.connect();

    // 1. Create OLD schema (without instance and last_latency_ms)
    await client.query(`CREATE TABLE webhook_events (id BIGSERIAL PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,payload JSONB NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','delivered','dead')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),locked_at TIMESTAMPTZ,last_status INTEGER,last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),delivered_at TIMESTAMPTZ)`);
    await client.query(`CREATE INDEX webhook_events_ready_idx ON webhook_events(next_attempt_at,id) WHERE state='pending'`);

    // 2. Insert a row with the old schema
    await client.query(`INSERT INTO webhook_events(event_key,payload) VALUES($1,$2)`, ['old-key', '{}']);

    // 3. Run migration (same statements server.ts runs on startup)
    await client.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS last_latency_ms INTEGER`);
    await client.query(`DROP INDEX IF EXISTS webhook_events_ready_idx`);
    await client.query(`CREATE INDEX webhook_events_ready_idx ON webhook_events(instance,next_attempt_at,id) WHERE state='pending'`);
    await client.query(`CREATE INDEX IF NOT EXISTS webhook_events_processing_idx ON webhook_events(instance) WHERE state='processing'`);

    // 4. Insert a row with the new schema
    await client.query(`INSERT INTO webhook_events(event_key,instance,payload) VALUES($1,$2,$3)`, ['new-key', 'line_test', '{}']);

    // 5. Verify both rows are accessible with new columns
    const result = await client.query<{ id: string, instance: string, last_latency_ms: number | null }>(`SELECT id::text, instance, last_latency_ms FROM webhook_events ORDER BY id`);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]!.instance, '');           // old row gets DEFAULT ''
    assert.equal(result.rows[0]!.last_latency_ms, null);  // old row gets NULL
    assert.equal(result.rows[1]!.instance, 'line_test');   // new row has instance
    assert.equal(result.rows[1]!.last_latency_ms, null);   // new row, not yet delivered

    // 6. Verify UPDATE with last_latency_ms works (simulates delivery)
    await client.query(`UPDATE webhook_events SET state='delivered',last_latency_ms=42 WHERE id=$1`, [result.rows[1]!.id]);
    const delivered = await client.query<{ last_latency_ms: number }>(`SELECT last_latency_ms FROM webhook_events WHERE id=$1`, [result.rows[1]!.id]);
    assert.equal(delivered.rows[0]!.last_latency_ms, 42);

    await client.end();
  } finally {
    await execDocker('rm', '-f', name).catch(() => undefined);
  }
});

test('concurrent: per-instance ordering with multiple workers', { timeout: 60_000 }, async (t) => {
  try { await execDocker('version', '--format', '{{.Server.Version}}'); }
  catch { t.skip('Docker is required for PostgreSQL concurrent tests'); return; }

  const name = `aricrm-concurrent-it-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  let gateway: Gateway | undefined; let target: Server | undefined;
  const deliveryOrder: string[] = [];
  try {
    await execDocker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_DB=gateway', '-e', 'POSTGRES_USER=gateway', '-e', 'POSTGRES_PASSWORD=gateway-test-password', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const portLine = await execDocker('port', name, '5432/tcp');
    const postgresPort = Number(portLine.slice(portLine.lastIndexOf(':') + 1));
    await waitFor(async () => {
      try { await execDocker('exec', name, 'psql', '-U', 'gateway', '-d', 'gateway', '-Atqc', 'SELECT 1'); return true; }
      catch { return false; }
    });
    await sleep(500);
    const databaseUrl = `postgres://gateway:gateway-test-password@127.0.0.1:${postgresPort}/gateway`;

    // Target server records delivery order per instance
    target = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: { key?: { id?: string } } };
      const eventId = body.data?.key?.id ?? '';
      if (eventId) deliveryOrder.push(eventId);
      // Small delay to widen the window where parallel delivery would be detectable
      await sleep(50);
      response.writeHead(200).end('{}');
    });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`;

    // Start gateway with WORKERS=2
    gateway = await startGateway(await freePort(), databaseUrl, targetUrl);

    // Send 5 events for the SAME instance with sequential key IDs
    const instance = 'concurrent-test-line';
    for (let i = 1; i <= 5; i++) {
      const id = `msg-${i}`;
      const response: Response = await fetch(`${gateway!.baseUrl}/v1/evolution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gateway-token': ingressToken },
        body: JSON.stringify({ event: 'messages.upsert', instance, data: { key: { id } } }),
      });
      assert.equal(response.status, 200);
    }

    // Wait for all 5 events to be delivered
    await waitFor(async () => deliveryOrder.length === 5, 20_000);

    // Verify: events for the same instance were delivered in insertionF order
    assert.deepEqual(deliveryOrder, ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5'],
      'per-instance delivery must respect insertion order even with WORKERS=2');
  } finally {
    if (gateway) await stop(gateway.child);
    if (target) await new Promise<void>(resolve => target!.close(() => resolve()));
    await execDocker('rm', '-f', name).catch(() => undefined);
  }
});