import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyInitData } from './telegram.js';
import { issueSession, verifySession } from './session.js';

const BOT = '123456:FAKE_TOKEN';

function makeInitData(authDate: number, token = BOT): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAH');
  params.set('user', JSON.stringify({ id: 42, first_name: 'T', username: 'tester' }));
  const dcs = [...params.keys()]
    .sort()
    .map((k) => `${k}=${params.get(k)}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('verifyInitData', () => {
  const now = Math.floor(Date.now() / 1000);

  it('accepts fresh, correctly-signed initData and parses the user', () => {
    const u = verifyInitData(makeInitData(now), BOT);
    expect(u).not.toBeNull();
    expect(u?.id).toBe('42');
    expect(u?.username).toBe('tester');
  });

  it('rejects tampered hash', () => {
    const bad = makeInitData(now).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
    expect(verifyInitData(bad, BOT)).toBeNull();
  });

  it('rejects stale initData beyond the TTL', () => {
    expect(verifyInitData(makeInitData(now - 90_000), BOT)).toBeNull();
  });

  it('rejects a wrong bot token', () => {
    expect(verifyInitData(makeInitData(now), 'wrong:token')).toBeNull();
  });

  it('rejects missing hash', () => {
    expect(verifyInitData('auth_date=' + now + '&user=%7B%7D', BOT)).toBeNull();
  });
});

describe('session tokens', () => {
  const SECRET = 'test-secret';

  it('round-trips an issued session', () => {
    const t = issueSession('user-uuid-1', SECRET, 3600);
    const p = verifySession(t, SECRET);
    expect(p?.uid).toBe('user-uuid-1');
  });

  it('rejects a token signed with a different secret', () => {
    const t = issueSession('user-uuid-1', SECRET);
    expect(verifySession(t, 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const t = issueSession('user-uuid-1', SECRET);
    const tampered = 'x' + t.slice(1);
    expect(verifySession(tampered, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const t = issueSession('user-uuid-1', SECRET, -10); // already expired
    expect(verifySession(t, SECRET)).toBeNull();
  });
});
