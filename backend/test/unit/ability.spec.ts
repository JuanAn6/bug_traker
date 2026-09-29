import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../../src/shared/config';
import type { Project, User, WorkflowConfig } from '../../src/shared/models';
import { createSeed } from '../../src/shared/seed';
import {
  can, canDeleteAttachment, canEditIssue, canEditNote, canMonitorFor, canSeeIssue, canSeeNote,
  canSeeProject, levelIn,
} from '../../src/modules/auth/ability';

/**
 * Exercised against the seeded cast, which was built to cover the level range: one admin (90),
 * one manager (70), three developers (55), one updater (40), one reporter (25), and one
 * disabled viewer (10). Four projects, one of them private and one a subproject.
 */
describe('ability', () => {
  const db = createSeed(Date.UTC(2026, 8, 29));
  const wf: WorkflowConfig = defaultWorkflow();
  const user = (username: string): User => db.users.find((u) => u.username === username)!;
  const project = (key: string): Project => db.projects.find((p) => p.key === key)!;

  const admin = user('administrator');   // 90
  const manager = user('mlopez');        // 70, member of every project
  const dkim = user('dkim');             // 55, member of WEB(55), DATA(55), ADM(55)
  const eschulz = user('eschulz');       // 40, member of WEB(40), DATA(40)
  const nwilliams = user('nwilliams');   // 25, member of WEB(25), MOB(25)
  const cdubois = user('cdubois');       // 10, disabled, member of nothing

  const web = project('WEB');            // public
  const mob = project('MOB');            // public
  const data = project('DATA');          // PRIVATE
  const adm = project('ADM');            // public, subproject of WEB

  describe('levelIn', () => {
    it('falls back to the global level with no project context', () => {
      expect(levelIn(dkim, undefined)).toBe(55);
      expect(levelIn(nwilliams, undefined)).toBe(25);
    });

    it('lets a membership REPLACE the global level, downwards included', () => {
      // This is the part most permission systems get wrong by taking a max().
      const demoted: User = { ...manager, accessLevel: 70 };
      const withLowMember: Project = {
        ...web,
        members: [{ userId: demoted.id, accessLevel: 25 }],
      };
      expect(levelIn(demoted, withLowMember)).toBe(25);
    });

    it('never demotes an administrator', () => {
      const withAdminDemoted: Project = {
        ...web,
        members: [{ userId: admin.id, accessLevel: 10 }],
      };
      expect(levelIn(admin, withAdminDemoted)).toBe(90);
    });

    it('uses the project level for members of the seeded projects', () => {
      expect(levelIn(nwilliams, web)).toBe(25);
      expect(levelIn(eschulz, data)).toBe(40);
      // Not a member of MOB, so the global level applies.
      expect(levelIn(eschulz, mob)).toBe(40);
    });
  });

  describe('can', () => {
    it('compares the effective level against the runtime threshold', () => {
      expect(can(dkim, 'assign', web, wf)).toBe(true);        // 55 >= 55
      expect(can(dkim, 'delete', web, wf)).toBe(false);       // 55 <  70
      expect(can(manager, 'delete', web, wf)).toBe(true);     // 70 >= 70
      expect(can(manager, 'manageUsers', web, wf)).toBe(false); // 70 < 90
      expect(can(admin, 'manageUsers', web, wf)).toBe(true);
    });

    it('treats an unauthenticated caller as a viewer, not as denied', () => {
      expect(can(null, 'view', web, wf)).toBe(true);   // threshold 10
      expect(can(null, 'report', web, wf)).toBe(false); // threshold 25
    });

    it('reacts to a runtime threshold change', () => {
      // Authorization is data: raising `assign` to 70 must lock out a developer immediately.
      const raised: WorkflowConfig = { ...wf, thresholds: { ...wf.thresholds, assign: 70 } };
      expect(can(dkim, 'assign', web, wf)).toBe(true);
      expect(can(dkim, 'assign', web, raised)).toBe(false);
    });

    it('applies the project membership rather than the global level', () => {
      // nwilliams is a reporter globally (25) and a member of WEB at 25 — still cannot update.
      expect(can(nwilliams, 'update', web, wf)).toBe(false);
      // eschulz is an updater (40): enough for `update`, not for `assign`.
      expect(can(eschulz, 'update', web, wf)).toBe(true);
      expect(can(eschulz, 'assign', web, wf)).toBe(false);
    });
  });

  describe('canSeeProject', () => {
    it('shows public projects to everyone authenticated', () => {
      expect(canSeeProject(nwilliams, web)).toBe(true);
      expect(canSeeProject(nwilliams, mob)).toBe(true);
    });

    it('hides a private project from non-members below manager', () => {
      expect(canSeeProject(nwilliams, data)).toBe(false); // not a member
      expect(canSeeProject(dkim, data)).toBe(true);       // member
      expect(canSeeProject(manager, data)).toBe(true);    // global 70 override
      expect(canSeeProject(admin, data)).toBe(true);
    });

    it('hides a disabled project from everyone below manager, member or not', () => {
      // The precedence trap: `!enabled && level < 70` binds tighter than the `||` chain, so
      // being a member does NOT rescue visibility of a disabled project.
      const disabled: Project = { ...web, enabled: false };
      expect(canSeeProject(dkim, disabled)).toBe(false);
      expect(canSeeProject(nwilliams, disabled)).toBe(false);
      expect(canSeeProject(manager, disabled)).toBe(true);
    });

    it('rejects an unauthenticated caller', () => {
      expect(canSeeProject(null, web)).toBe(false);
    });
  });

  describe('canSeeIssue', () => {
    const publicIssue = { projectId: 1, viewState: 'public' as const, reporterId: 7, handlerId: 4 };
    const privateIssue = { projectId: 1, viewState: 'private' as const, reporterId: 7, handlerId: 4 };

    it('shows public issues in visible projects', () => {
      expect(canSeeIssue(nwilliams, publicIssue, web, wf)).toBe(true);
    });

    it('hides a private issue from someone below the viewPrivate threshold', () => {
      // nwilliams is the reporter here, so this one is visible to them...
      expect(canSeeIssue(nwilliams, privateIssue, web, wf)).toBe(true);
      // ...but not one they neither reported nor handle.
      const someoneElses = { ...privateIssue, reporterId: 2, handlerId: 5 };
      expect(canSeeIssue(nwilliams, someoneElses, web, wf)).toBe(false);
      expect(canSeeIssue(eschulz, someoneElses, web, wf)).toBe(false); // 40 < 55
      expect(canSeeIssue(dkim, someoneElses, web, wf)).toBe(true);     // 55 >= viewPrivate
    });

    it('shows a private issue to its reporter and its handler', () => {
      const mine = { ...privateIssue, reporterId: eschulz.id, handlerId: null };
      expect(canSeeIssue(eschulz, mine, web, wf)).toBe(true);
      const assignedToMe = { ...privateIssue, reporterId: 2, handlerId: eschulz.id };
      expect(canSeeIssue(eschulz, assignedToMe, web, wf)).toBe(true);
    });

    it('hides everything in an invisible project, however public the issue', () => {
      const inData = { ...publicIssue, projectId: data.id };
      expect(canSeeIssue(nwilliams, inData, data, wf)).toBe(false);
    });

    it('returns false when the project is unknown', () => {
      expect(canSeeIssue(admin, publicIssue, undefined, wf)).toBe(false);
    });
  });

  describe('notes', () => {
    const publicNote = { authorId: 2, private: false };
    const privateNote = { authorId: 2, private: true };

    it('shows public notes to anyone who can see the issue', () => {
      expect(canSeeNote(nwilliams, publicNote, web, wf)).toBe(true);
    });

    it('restricts private notes to the author and to viewPrivate', () => {
      expect(canSeeNote(nwilliams, privateNote, web, wf)).toBe(false);
      expect(canSeeNote(eschulz, privateNote, web, wf)).toBe(false); // 40 < 55
      expect(canSeeNote(dkim, privateNote, web, wf)).toBe(true);
      const own = { authorId: nwilliams.id, private: true };
      expect(canSeeNote(nwilliams, own, web, wf)).toBe(true);
    });

    it('lets the author edit, and others only with editOthersNotes', () => {
      const own = { authorId: nwilliams.id, private: false };
      expect(canEditNote(nwilliams, own, web, wf)).toBe(true);
      expect(canEditNote(dkim, own, web, wf)).toBe(false);    // 55 < 70
      expect(canEditNote(manager, own, web, wf)).toBe(true);  // 70 >= editOthersNotes
    });
  });

  describe('canEditIssue', () => {
    it('allows anyone with the update threshold', () => {
      const issue = { projectId: 1, viewState: 'public' as const, reporterId: 2, handlerId: null };
      expect(canEditIssue(eschulz, issue, web, wf)).toBe(true);   // 40 >= update
      expect(canEditIssue(nwilliams, issue, web, wf)).toBe(false); // 25 < update
    });

    it('also allows the reporter with only the report threshold', () => {
      // The one identity-based widening: your own issue needs `report`, not `update`.
      const mine = { projectId: 1, viewState: 'public' as const, reporterId: nwilliams.id, handlerId: null };
      expect(canEditIssue(nwilliams, mine, web, wf)).toBe(true);
    });
  });

  describe('attachments and monitors', () => {
    it('lets the uploader delete, and others only with deleteOthersFiles', () => {
      const theirs = { uploaderId: 2 };
      expect(canDeleteAttachment(dkim, theirs, web, wf)).toBe(false);   // 55 < 70
      expect(canDeleteAttachment(manager, theirs, web, wf)).toBe(true);
      expect(canDeleteAttachment(dkim, { uploaderId: dkim.id }, web, wf)).toBe(true);
    });

    it('needs monitorOthers to subscribe somebody else, evaluated globally', () => {
      expect(canMonitorFor(nwilliams, nwilliams.id, wf)).toBe(true);
      expect(canMonitorFor(nwilliams, 4, wf)).toBe(false);
      expect(canMonitorFor(dkim, 4, wf)).toBe(true); // 55 >= monitorOthers
    });
  });

  describe('the whole seeded cast', () => {
    it('gives every user a defined effective level in every project', () => {
      for (const u of db.users) {
        for (const p of db.projects) {
          const level = levelIn(u, p);
          expect(typeof level, `${u.username}/${p.key}`).toBe('number');
          expect(level).toBeGreaterThanOrEqual(10);
        }
      }
    });

    it('never grants an action to a level below its threshold', () => {
      // A blanket sweep: for all 8 users × 4 projects × 22 actions, can() must agree with a
      // direct comparison. Catches any accidental special-casing inside can().
      for (const u of db.users) {
        for (const p of db.projects) {
          for (const [action, threshold] of Object.entries(wf.thresholds)) {
            const expected = levelIn(u, p) >= threshold;
            expect(can(u, action as never, p, wf), `${u.username}/${p.key}/${action}`).toBe(expected);
          }
        }
      }
    });

    it('keeps the disabled user out of nothing by itself — enabled is checked elsewhere', () => {
      // Worth pinning: ability() does NOT look at `enabled`. The frontend's Auth.user()
      // returns null for a disabled account, so the check lives at authentication time. If
      // the API ever relied on ability alone, a disabled user would keep their rights.
      expect(cdubois.enabled).toBe(false);
      expect(can(cdubois, 'view', web, wf)).toBe(true);
    });
  });
});
