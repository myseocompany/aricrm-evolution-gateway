import { createHash, timingSafeEqual } from 'node:crypto';

export function secureEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function eventKey(payload: any, rawBody: string): string {
  return createHash('sha256')
    .update(String(payload?.instance ?? '')).update('\0')
    .update(String(payload?.event ?? '')).update('\0')
    .update(String(payload?.data?.key?.id ?? '')).update('\0')
    .update(rawBody).digest('hex');
}

export function retryDelayMs(attempt: number, random = Math.random()): number {
  const seconds = Math.min(900, 2 ** Math.max(0, attempt - 1));
  return Math.floor(seconds * (0.8 + random * 0.4) * 1000);
}

export function classifyStatus(status: number): 'delivered'|'retry'|'auth_dead'|'dead' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 401 || status === 403) return 'auth_dead';
  if (status === 429 || status >= 500) return 'retry';
  return 'dead';
}
