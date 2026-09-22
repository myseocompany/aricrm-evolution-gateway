import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { classifyStatus, eventKey, retryDelayMs, secureEqual } from './core.js';

const required = (name: string): string => { const value = process.env[name] ?? ''; if (!value) throw new Error(`${name} is required`); return value; };
const integer = (name: string, fallback: number): number => { const n = Number.parseInt(process.env[name] ?? '', 10); return n > 0 ? n : fallback; };
const ingressToken = required('INGRESS_TOKEN');
if (ingressToken.length < 32) throw new Error('INGRESS_TOKEN must contain at least 32 characters');
const metricsToken = required('METRICS_TOKEN');
if (metricsToken.length < 32) throw new Error('METRICS_TOKEN must contain at least 32 characters');
const targetUrl = required('TARGET_URL');
const workers = integer('WORKERS', 4);
const timeoutMs = integer('TARGET_TIMEOUT_SECONDS', 15) * 1000;
const maxAttempts = integer('MAX_ATTEMPTS', 12);
const retentionHours = integer('DELIVERED_RETENTION_HOURS', 72);
const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 10 });
const app = Fastify({ logger: { redact: ['req.headers.apikey','req.headers.x-gateway-token','req.headers.x-gateway-metrics-token','req.query.token'] }, bodyLimit: 2 * 1024 * 1024 });
let circuitUntil = 0;
let stopping = false;

await pool.query(`CREATE TABLE IF NOT EXISTS webhook_events (id BIGSERIAL PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,payload JSONB NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','delivered','dead')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),locked_at TIMESTAMPTZ,last_status INTEGER,last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),delivered_at TIMESTAMPTZ); CREATE INDEX IF NOT EXISTS webhook_events_ready_idx ON webhook_events(next_attempt_at,id) WHERE state='pending'; UPDATE webhook_events SET state='pending',locked_at=NULL WHERE state='processing' AND locked_at < now()-interval '5 minutes'`);
await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

app.post('/v1/evolution', async (request, reply) => {
  const query = request.query as {token?: string};
  const token = String(request.headers['x-gateway-token'] ?? request.headers.apikey ?? query.token ?? '').trim();
  if (!secureEqual(ingressToken, token)) return reply.code(401).send({ok:false});
  const raw = JSON.stringify(request.body);
  try {
    const result = await pool.query<{id:string}>(`INSERT INTO webhook_events(event_key,payload) VALUES($1,$2::jsonb) ON CONFLICT(event_key) DO UPDATE SET event_key=EXCLUDED.event_key RETURNING id::text`, [eventKey(request.body, raw), raw]);
    return reply.code(200).send({ok:true,id:result.rows[0]!.id});
  } catch (error) {
    request.log.error({err:error}, 'persist_failed');
    return reply.code(503).send({ok:false});
  }
});

app.get('/healthz', async (_request, reply) => { try { await pool.query('SELECT 1'); return {ok:true}; } catch { return reply.code(503).send({ok:false}); } });
app.get('/metrics', async (request, reply) => {
  const token = String(request.headers['x-gateway-metrics-token'] ?? '').trim();
  if (!secureEqual(metricsToken, token)) return reply.code(401).send({ok:false});
  const result = await pool.query<{state:string,count:string,pending_age_seconds:string}>(`
    SELECT state,
      count(*)::text AS count,
      COALESCE(floor(EXTRACT(epoch FROM now() - min(created_at) FILTER (WHERE state = 'pending'))), 0)::text AS pending_age_seconds
    FROM webhook_events
    GROUP BY state
  `);
  const events = Object.fromEntries(result.rows.map(r => [r.state,Number(r.count)]));
  const pendingAgeSeconds = Math.max(0, ...result.rows.map(r => Number(r.pending_age_seconds)));
  return {ok:true,events,pendingAgeSeconds,circuitOpen:Date.now()<circuitUntil};
});

type Event = {id:string,payload:unknown,attempts:number};
async function claim(): Promise<Event|null> {
  const result = await pool.query<Event>(`WITH candidate AS (SELECT id FROM webhook_events WHERE state='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE webhook_events e SET state='processing',locked_at=now(),attempts=attempts+1 FROM candidate c WHERE e.id=c.id RETURNING e.id::text,e.payload,e.attempts`);
  return result.rows[0] ?? null;
}
async function deliver(event: Event): Promise<void> {
  try {
    const response = await fetch(targetUrl,{method:'POST',headers:{'content-type':'application/json','user-agent':'AriCRM-Webhook-Gateway/1.0'},body:JSON.stringify(event.payload),signal:AbortSignal.timeout(timeoutMs)});
    await response.body?.cancel();
    const kind = classifyStatus(response.status);
    if (kind === 'delivered') { await pool.query(`UPDATE webhook_events SET state='delivered',delivered_at=now(),locked_at=NULL,last_status=$2,last_error=NULL WHERE id=$1`,[event.id,response.status]); return; }
    if (kind === 'auth_dead') { circuitUntil=Date.now()+300_000; app.log.error({eventId:event.id,status:response.status},'target_auth_rejected'); await dead(event,response.status,'target_auth_rejected'); return; }
    if (kind === 'dead' || event.attempts >= maxAttempts) { await dead(event,response.status,'target_rejected'); return; }
    await retry(event,response.status,'target_rejected');
  } catch {
    if (event.attempts >= maxAttempts) await dead(event,null,'target_unreachable'); else await retry(event,null,'target_unreachable');
  }
}
async function retry(event:Event,status:number|null,reason:string):Promise<void>{await pool.query(`UPDATE webhook_events SET state='pending',locked_at=NULL,next_attempt_at=now()+($2*interval '1 millisecond'),last_status=$3,last_error=$4 WHERE id=$1`,[event.id,retryDelayMs(event.attempts),status,reason]);}
async function dead(event:Event,status:number|null,reason:string):Promise<void>{await pool.query(`UPDATE webhook_events SET state='dead',locked_at=NULL,last_status=$2,last_error=$3 WHERE id=$1`,[event.id,status,reason]);}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function worker():Promise<void>{while(!stopping){if(Date.now()<circuitUntil){await sleep(500);continue;}const event=await claim();if(!event){await sleep(250);continue;}await deliver(event);}}
for(let i=0;i<workers;i++) void worker();
const maintenance=setInterval(()=>void pool.query(`DELETE FROM webhook_events WHERE state='delivered' AND delivered_at<now()-($1*interval '1 hour'); UPDATE webhook_events SET state='pending',locked_at=NULL WHERE state='processing' AND locked_at<now()-interval '5 minutes'`,[retentionHours]),3_600_000);
async function shutdown(){stopping=true;clearInterval(maintenance);await app.close();await pool.end();}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
await app.listen({host:'0.0.0.0',port:integer('PORT',8080)});
