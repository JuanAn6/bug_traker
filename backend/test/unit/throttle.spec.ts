import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MemoryCacheAdapter } from '../../src/core/adapters/memory-cache.adapter';
import { THROTTLE, ThrottleGuard, type ThrottleOptions } from '../../src/common/guards/throttle.guard';

/**
 * The login throttle, tested here rather than end to end.
 *
 * It has to be: the e2e suite performs several hundred logins from one address, so the server it
 * runs against is configured with a limit no test could trip. The mechanism is a fixed-window
 * counter, which is exactly the kind of thing a unit test pins precisely.
 */
describe('ThrottleGuard', () => {
  const build = (options: ThrottleOptions, limit = 3) => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);
    const config = {
      get: (key: string) => (key === 'THROTTLE_LOGIN_MAX' ? limit : 60_000),
    } as never;
    return new ThrottleGuard(reflector, new MemoryCacheAdapter(), config);
  };

  const context = (request: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  it('lets a route through untouched when it declares no throttle', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new ThrottleGuard(reflector, new MemoryCacheAdapter(), { get: () => 10 } as never);
    for (let i = 0; i < 50; i++) {
      expect(await guard.canActivate(context({ ip: '1.2.3.4' }))).toBe(true);
    }
  });

  it('allows exactly `limit` requests and then answers 429', async () => {
    const guard = build({ name: 'login' }, 3);
    const request = { ip: '1.2.3.4' };
    for (let i = 0; i < 3; i++) {
      expect(await guard.canActivate(context(request))).toBe(true);
    }
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      response: { statusCode: 429, code: 'errors.tooManyRequests' },
    });
  });

  it('counts different addresses separately', async () => {
    const guard = build({ name: 'login' }, 2);
    await guard.canActivate(context({ ip: '1.1.1.1' }));
    await guard.canActivate(context({ ip: '1.1.1.1' }));
    await expect(guard.canActivate(context({ ip: '1.1.1.1' }))).rejects.toThrow();
    // A second address has its own bucket.
    expect(await guard.canActivate(context({ ip: '2.2.2.2' }))).toBe(true);
  });

  it('also counts per username, which is the bucket that stops a password list', async () => {
    // Credential stuffing spreads ONE address over many accounts; an office behind a NAT spreads
    // many people over one address. Counting both is what tells those apart.
    const guard = build({ name: 'login', subjectFrom: 'username' }, 2);
    const attempt = (ip: string, username: string) =>
      guard.canActivate(context({ ip, body: { username } }));

    await attempt('1.1.1.1', 'victim');
    await attempt('2.2.2.2', 'victim');
    // Third try at the same account from a third address: the per-subject bucket is full.
    await expect(attempt('3.3.3.3', 'victim')).rejects.toThrow();
    // A different account from that same third address still works.
    expect(await attempt('3.3.3.3', 'somebody-else')).toBe(true);
  });

  it('is case- and whitespace-insensitive about the subject', async () => {
    const guard = build({ name: 'login', subjectFrom: 'username' }, 2);
    const attempt = (username: string) =>
      guard.canActivate(context({ ip: '9.9.9.9', body: { username } }));
    await attempt('Victim');
    await attempt('  VICTIM  ');
    await expect(attempt('victim')).rejects.toThrow();
  });

  it('counts by address alone when the body carries no subject', async () => {
    const guard = build({ name: 'login', subjectFrom: 'username' }, 2);
    const request = { ip: '4.4.4.4', body: {} };
    await guard.canActivate(context(request));
    await guard.canActivate(context(request));
    await expect(guard.canActivate(context(request))).rejects.toThrow();
  });

  it('counts an authenticated caller by account rather than by address', async () => {
    const guard = build({ name: 'password', limit: 2 }, 99);
    const asUser = (ip: string) => guard.canActivate(context({ ip, authUser: { id: 7 } }));
    await asUser('1.1.1.1');
    await asUser('2.2.2.2');
    // Changing address does not refill the bucket: the identity is the account.
    await expect(asUser('3.3.3.3')).rejects.toThrow();
  });

  it('resets once the window expires', async () => {
    const guard = build({ name: 'login', windowMs: 30 }, 1);
    const request = { ip: '5.5.5.5' };
    expect(await guard.canActivate(context(request))).toBe(true);
    await expect(guard.canActivate(context(request))).rejects.toThrow();
    // The TTL is the reset — that is the whole mechanism of a fixed window.
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(await guard.canActivate(context(request))).toBe(true);
  });
});
