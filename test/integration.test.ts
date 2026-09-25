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
async function startGateway(port: number, databaseUrl: string, targetUrl: string): Promise<Gateway> {
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, TARGET_URL: targetUrl, INGRESS_TOKEN: ingressToken, METRICS_TOKEN: metricsToken, EGRESS_USER_AGENT: 'integration-test/1.0', TARGET_TIMEOUT_SECONDS: '1', WORKERS: '1', MAX_ATTEMPTS: '3' },
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
