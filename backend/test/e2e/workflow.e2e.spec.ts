import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { defaultWorkflow } from '../../src/shared/config';
import type { WorkflowConfig } from '../../src/shared/models';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool } from '../../src/core/database/drizzle.service';
import { ingestDb } from '../../src/modules/admin/db-import';
import { ApiClient, startServer, stopServer } from './harness';

/**
 * Covers the ThresholdGuard end to end, and the property the whole authorization design rests
 * on: thresholds are DATA, so editing them changes what the API permits on the next request.
 */
describe('workflow', () => {
  let pool: ReturnType<typeof createPool>;
  let admin: ApiClient;

  const seedDb = async () => {
    await ingestDb(createDb(pool), createSeed(Date.UTC(2026, 8, 29)), {
      mode: 'replace',
      passwordHash: await hash('demo', { algorithm: 2 }),
      source: 'workflow.e2e',
    });
  };

  beforeAll(async () => {
    const url = process.env['DATABASE_URL_TEST'];
    if (!url) throw new Error('DATABASE_URL_TEST is required');
    pool = createPool({ url, poolSize: 2 });
    await seedDb();
    await startServer();
  }, 120_000);

  afterAll(async () => {
    await stopServer();
    await pool?.end();
  });

  beforeEach(async () => {
    admin = new ApiClient();
    await admin.login('administrator');
    // Each test starts from the shipped defaults, since several of them rewrite the config.
    await admin.post('/workflow/reset');
  });

  describe('GET', () => {
    it('is readable by any authenticated user, whatever their level', async () => {
      // The shell paints --status-* from statusColors and the board reads boardColumns, so
      // gating this on manageWorkflow would break the UI for everyone below level 90.
      for (const username of ['administrator', 'mlopez', 'dkim', 'nwilliams']) {
        const api = new ApiClient();
        await api.login(username);
        const response = await api.get<WorkflowConfig>('/workflow');
        expect(response.status, username).toBe(200);
        expect(Object.keys(response.body.thresholds)).toHaveLength(22);
      }
    });

    it('needs authentication', async () => {
      expect((await new ApiClient().get('/workflow')).status).toBe(401);
    });

    it('reassembles exactly the shape the frontend defaults define', async () => {
      const response = await admin.get<WorkflowConfig>('/workflow');
      const base = defaultWorkflow();
      expect(response.body.thresholds).toEqual(base.thresholds);
      expect(response.body.statusColors).toEqual(base.statusColors);
      expect(response.body.boardColumns).toEqual(base.boardColumns);
      expect(response.body.autoAssignStatus).toBe(base.autoAssignStatus);
      expect(response.body.resolvedStatus).toBe(base.resolvedStatus);
      // Sparse on purpose: only 'assigned' has a limit by default.
      expect(response.body.wipLimits).toEqual({ assigned: 12 });
      // Transitions come back as arrays per status; order within a status is not contractual,
      // so compare as sets.
      for (const [from, tos] of Object.entries(base.transitions)) {
        expect(new Set(response.body.transitions[from as never]), from).toEqual(new Set(tos));
      }
    });
  });

  describe('PUT is gated by manageWorkflow (threshold 90)', () => {
    it.each([
      ['mlopez', 70],
      ['dkim', 55],
      ['eschulz', 40],
      ['nwilliams', 25],
    ])('refuses %s (level %i) with 403 errors.denied', async (username) => {
      const api = new ApiClient();
      await api.login(username);
      const response = await api.put('/workflow', defaultWorkflow());
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'errors.denied' });
    });

    it('allows the administrator', async () => {
      const base = defaultWorkflow();
      const response = await admin.put<WorkflowConfig>('/workflow', {
        ...base,
        autoAssignStatus: false,
      });
      expect(response.status).toBe(200);
      expect(response.body.autoAssignStatus).toBe(false);
    });

    it('refuses an unauthenticated caller before ever checking the threshold', async () => {
      expect((await new ApiClient().put('/workflow', defaultWorkflow())).status).toBe(401);
    });
  });

  describe('validation', () => {
    it('rejects a payload missing a status from transitions', async () => {
      // A status with no outgoing edges would silently freeze every issue in it.
      const base = defaultWorkflow();
      const { closed: _dropped, ...partial } = base.transitions;
      const response = await admin.put('/workflow', { ...base, transitions: partial });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'errors.validation' });
    });

    it('rejects a payload missing one of the 22 thresholds', async () => {
      const base = defaultWorkflow();
      const { manageWorkflow: _dropped, ...partial } = base.thresholds;
      const response = await admin.put('/workflow', { ...base, thresholds: partial });
      expect(response.status).toBe(422);
    });

    it('rejects a threshold that is not a real access level', async () => {
      const base = defaultWorkflow();
      const response = await admin.put('/workflow', {
        ...base,
        thresholds: { ...base.thresholds, assign: 42 },
      });
      expect(response.status).toBe(422);
    });

    it('rejects a malformed colour and an unknown extra field', async () => {
      const base = defaultWorkflow();
      expect(
        (await admin.put('/workflow', {
          ...base,
          statusColors: { ...base.statusColors, new: 'red' },
        })).status,
      ).toBe(422);
      expect((await admin.put('/workflow', { ...base, surprise: 1 })).status).toBe(422);
    });
  });

  describe('thresholds are configuration, not code', () => {
    it('takes effect on the very next request', async () => {
      // The property the design rests on: authorization is data, and the cache is keyed by
      // revision so an edit is not hidden behind a TTL.
      const base = defaultWorkflow();

      const manager = new ApiClient();
      await manager.login('mlopez'); // level 70
      expect((await manager.put('/workflow', base)).status).toBe(403);

      // Hand manageWorkflow to level 70...
      expect(
        (await admin.put('/workflow', {
          ...base,
          thresholds: { ...base.thresholds, manageWorkflow: 70 },
        })).status,
      ).toBe(200);

      // ...and the manager can immediately do what they could not a moment ago.
      const now = await manager.put<WorkflowConfig>('/workflow', {
        ...base,
        thresholds: { ...base.thresholds, manageWorkflow: 70 },
        autoAssignStatus: false,
      });
      expect(now.status).toBe(200);
      expect(now.body.autoAssignStatus).toBe(false);
    });

    it('stores wip limits sparsely, dropping zeroes', async () => {
      const base = defaultWorkflow();
      const response = await admin.put<WorkflowConfig>('/workflow', {
        ...base,
        wipLimits: { assigned: 5, confirmed: 0, new: 3 },
      });
      expect(response.status).toBe(200);
      // 0 means "no limit", so it is absent rather than stored — matching the frontend, which
      // deletes the key when the input is cleared.
      expect(response.body.wipLimits).toEqual({ assigned: 5, new: 3 });
    });

    it('round-trips a rewritten transition matrix', async () => {
      const base = defaultWorkflow();
      const response = await admin.put<WorkflowConfig>('/workflow', {
        ...base,
        transitions: { ...base.transitions, closed: ['feedback', 'assigned'] },
      });
      expect(response.status).toBe(200);
      expect(new Set(response.body.transitions.closed)).toEqual(new Set(['feedback', 'assigned']));
    });
  });

  describe('reset', () => {
    it('restores the defaults and is itself gated', async () => {
      const base = defaultWorkflow();
      await admin.put('/workflow', { ...base, autoAssignStatus: false, wipLimits: {} });

      const developer = new ApiClient();
      await developer.login('dkim');
      expect((await developer.post('/workflow/reset')).status).toBe(403);

      const response = await admin.post<WorkflowConfig>('/workflow/reset');
      expect(response.status).toBe(201);
      expect(response.body.autoAssignStatus).toBe(true);
      expect(response.body.wipLimits).toEqual({ assigned: 12 });
    });
  });
});
