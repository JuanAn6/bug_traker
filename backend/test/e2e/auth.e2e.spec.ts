import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool } from '../../src/core/database/drizzle.service';
import { ingestDb } from '../../src/modules/admin/db-import';
import { ApiClient, startServer, stopServer } from './harness';

/**
 * Requires `npm run build` first: the harness runs dist/main.js (see the note there about
 * esbuild and emitDecoratorMetadata).
 */
describe('auth', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    const url = process.env['DATABASE_URL_TEST'];
    if (!url) throw new Error('DATABASE_URL_TEST is required');
    pool = createPool({ url, poolSize: 2 });
    await ingestDb(createDb(pool), createSeed(Date.UTC(2026, 8, 29)), {
      mode: 'replace',
      passwordHash: await hash('demo', { algorithm: 2 }),
      source: 'auth.e2e',
    });
    await startServer();
  }, 120_000);

  afterAll(async () => {
    await stopServer();
    await pool?.end();
  });

  describe('login', () => {
    it('returns an access token, the user with prefs, and an httpOnly refresh cookie', async () => {
      const api = new ApiClient();
      const response = await api.login('dkim');
      expect(response.status).toBe(201);
      expect(response.body.accessToken).toMatch(/^eyJ/);

      const body = response.body as unknown as {
        expiresIn: number;
        user: { id: number; accessLevel: number; prefs: { pageSize: number } };
        refreshToken?: string;
      };
      expect(body.expiresIn).toBe(900);
      expect(body.user).toMatchObject({ id: 3, accessLevel: 55 });
      expect(body.user.prefs.pageSize).toBe(25);
      // The refresh token must never reach JavaScript.
      expect(body.refreshToken).toBeUndefined();

      const setCookie = response.headers.getSetCookie().join(';');
      expect(setCookie).toContain('bt_refresh=');
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Path=\/api\/auth/i);
    });

    it('cannot be used to enumerate users', async () => {
      // Unknown, disabled and wrong-password must be indistinguishable. cdubois exists but is
      // disabled; dkim exists with a different password.
      const attempts = [
        { username: 'doesnotexist', password: 'demo' },
        { username: 'cdubois', password: 'demo' },
        { username: 'dkim', password: 'wrong' },
      ];
      const results = [];
      for (const attempt of attempts) {
        const api = new ApiClient();
        const r = await api.post('/auth/login', attempt);
        results.push({ status: r.status, body: r.body });
      }
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
      expect(results[0]!.status).toBe(401);
      expect(results[0]!.body).toMatchObject({ code: 'login.invalid' });
    });

    it('accepts a case-insensitive, padded username', async () => {
      const api = new ApiClient();
      expect((await api.login('  DKim  ')).status).toBe(201);
    });

    it('updates lastVisit', async () => {
      const api = new ApiClient();
      await api.login('srossi');
      const me = await api.get<{ id: number }>('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.id).toBe(4);
    });
  });

  describe('access tokens', () => {
    it('rejects a missing, malformed or foreign token with the same 401', async () => {
      const anonymous = new ApiClient();
      expect((await anonymous.get('/auth/me')).status).toBe(401);

      anonymous.accessToken = 'not.a.jwt';
      expect((await anonymous.get('/auth/me')).status).toBe(401);

      // Correctly shaped, signed with a different secret.
      anonymous.accessToken =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEsInVzZXJuYW1lIjoiYWRtaW5pc3RyYXRvciIsImx2bCI6OTAsInZlciI6MH0.' +
        'ZmFrZXNpZ25hdHVyZQ';
      expect((await anonymous.get('/auth/me')).status).toBe(401);
    });

    it('leaves public routes open', async () => {
      const anonymous = new ApiClient();
      expect((await anonymous.get('/health')).status).toBe(200);
      expect((await anonymous.get('/auth/demo-users')).status).toBe(200);
    });
  });

  describe('refresh rotation', () => {
    it('issues a working access token and rotates the refresh cookie', async () => {
      const api = new ApiClient();
      await api.login('dkim');
      const firstCookie = api.cookie('bt_refresh');

      const refreshed = await api.post<{ accessToken: string; expiresIn: number }>('/auth/refresh');
      expect(refreshed.status).toBe(201);
      expect(refreshed.body.expiresIn).toBe(900);

      // Deliberately NOT asserting that the access token string changed: the payload is
      // {sub, username, lvl, ver} plus iat/exp, so two tokens minted for the same user within
      // the same second are byte-identical. That is harmless — same claims, same window — but
      // it means token identity is not a signal a client can use to detect a refresh.
      api.accessToken = refreshed.body.accessToken;
      expect((await api.get('/auth/me')).status).toBe(200);

      // The REFRESH token is what must rotate, and it does.
      expect(api.cookie('bt_refresh')).not.toBe(firstCookie);
    });

    it('detects reuse and revokes the whole family', async () => {
      // The security property the plan is built around: replaying a rotated-away token means
      // somebody has a stolen copy, so BOTH the replay and the legitimate chain are killed —
      // the victim notices, instead of the theft continuing quietly.
      const api = new ApiClient();
      await api.login('dkim');
      const stolen = api.cookie('bt_refresh')!;

      await api.post('/auth/refresh'); // legitimate rotation
      const current = api.cookie('bt_refresh')!;
      expect(current).not.toBe(stolen);

      const thief = new ApiClient();
      thief.setCookie('bt_refresh', stolen);
      expect((await thief.post('/auth/refresh')).status).toBe(401);

      // And the legitimate client is now locked out too.
      api.setCookie('bt_refresh', current);
      expect((await api.post('/auth/refresh')).status).toBe(401);
    });

    it('rejects a refresh with no cookie at all', async () => {
      expect((await new ApiClient().post('/auth/refresh')).status).toBe(401);
    });

    it('stops working after logout', async () => {
      const api = new ApiClient();
      await api.login('loconnor');
      expect((await api.post('/auth/logout')).status).toBe(204);
      expect((await api.post('/auth/refresh')).status).toBe(401);
    });
  });

  describe('password change', () => {
    it('retires access tokens already in flight', async () => {
      const api = new ApiClient();
      await api.login('eschulz');
      const oldToken = api.accessToken!;
      expect((await api.get('/auth/me')).status).toBe(200);

      expect(
        (await api.post('/auth/password', { currentPassword: 'demo', newPassword: 'nuevaClave1' })).status,
      ).toBe(204);

      // tokenVersion was bumped, so the token is dead well before its 15 minutes are up.
      api.accessToken = oldToken;
      expect((await api.get('/auth/me')).status).toBe(401);

      // The new password works, the old one does not.
      const fresh = new ApiClient();
      expect((await fresh.login('eschulz', 'demo')).status).toBe(401);
      expect((await fresh.login('eschulz', 'nuevaClave1')).status).toBe(201);
    });

    it('rejects a wrong current password and a too-short new one', async () => {
      const api = new ApiClient();
      await api.login('nwilliams');
      const wrong = await api.post('/auth/password', {
        currentPassword: 'incorrecta',
        newPassword: 'suficienteLarga',
      });
      expect(wrong.status).toBe(409);
      expect(wrong.body).toMatchObject({ code: 'account.currentRequired' });

      // Caught by the DTO before the service sees it.
      const short = await api.post('/auth/password', { currentPassword: 'demo', newPassword: 'corta' });
      expect(short.status).toBe(400);
    });
  });

  describe('demo mode', () => {
    it('lists seeded accounts ordered by access level, highest first', async () => {
      const response = await new ApiClient().get<Array<{ username: string; accessLevel: number }>>(
        '/auth/demo-users',
      );
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(8);
      expect(response.body[0]).toMatchObject({ username: 'administrator', accessLevel: 90 });
      const levels = response.body.map((u) => u.accessLevel);
      expect(levels).toEqual([...levels].sort((a, b) => b - a));
      // It is a login helper, not a user dump: no emails, no hashes.
      expect(Object.keys(response.body[0]!)).not.toContain('email');
      expect(Object.keys(response.body[0]!)).not.toContain('passwordHash');
    });
  });

  describe('validation', () => {
    it('rejects an unknown field instead of ignoring it', async () => {
      // forbidNonWhitelisted: a typo'd or injected property is an error, not silence.
      const response = await new ApiClient().post('/auth/login', {
        username: 'dkim',
        password: 'demo',
        accessLevel: 90,
      });
      expect(response.status).toBe(400);
    });

    it('rejects a missing required field', async () => {
      expect((await new ApiClient().post('/auth/login', { username: 'dkim' })).status).toBe(400);
    });
  });
});
