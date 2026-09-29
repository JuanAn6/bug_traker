import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Auth } from './auth.service';
import { IssueActions, IssueDraft } from './issue-actions.service';
import { Store } from './store.service';
import { doc } from './rich';

describe('IssueActions', () => {
  let store: Store;
  let actions: IssueActions;

  const draft = (patch: Partial<IssueDraft> = {}): IssueDraft => ({
    projectId: 1, sprintId: null, category: 'Backend API', summary: 'Test issue', description: doc('x'), stepsToReproduce: null,
    additionalInfo: null, status: 'new', resolution: 'open', priority: 'normal', severity: 'minor', reproducibility: 'always', platform: '',
    os: '', osBuild: '', productVersion: '', targetVersion: '', fixedInVersion: '', handlerId: null, viewState: 'public', tags: [],
    dueDate: null, estimate: null, storyPoints: null, customFields: {}, ...patch,
  });
  const historyOf = (id: number) => store.history().filter((h) => h.issueId === id);

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    store = TestBed.inject(Store);
    store.reset();
    actions = TestBed.inject(IssueActions);
    // dkim: developer (55) and member of Web Portal.
    expect(TestBed.inject(Auth).login('dkim', false)).toBe(true);
  });

  it('reports with the category default handler, auto "assigned" status and monitors', () => {
    const i = actions.report(draft())!;
    expect(i.handlerId).toBe(3); // Backend API default handler
    expect(i.status).toBe('assigned');
    expect(i.monitorIds).toEqual([3]);
    expect(historyOf(i.id).map((h) => h.type)).toEqual(['created']);
  });

  it('writes one history row per changed field', () => {
    const i = actions.report(draft({ category: 'Documentation' }))!;
    actions.update(i.id, { priority: 'high', summary: 'Renamed' });
    const rows = historyOf(i.id).filter((h) => h.type === 'field');
    expect(rows.map((h) => [h.field, h.old, h.new])).toEqual([
      ['summary', 'Test issue', 'Renamed'],
      ['priority', 'normal', 'high'],
    ]);
  });

  it('assigning a new issue moves it to "assigned" and notifies the handler', () => {
    const i = actions.report(draft({ category: 'Documentation' }))!;
    expect(i.status).toBe('new');
    actions.assign([i.id], 4);
    const after = store.issueMap().get(i.id)!;
    expect(after.status).toBe('assigned');
    expect(store.notifications().some((n) => n.userId === 4 && n.issueId === i.id && n.type === 'assigned')).toBe(true);
  });

  it('enforces workflow transitions and sets resolutions on resolve / reopen', () => {
    const i = actions.report(draft())!;
    expect(actions.changeStatus(i.id, 'resolved')).toBe(true);
    expect(store.issueMap().get(i.id)!.resolution).toBe('fixed');
    expect(actions.changeStatus(i.id, 'new')).toBe(false); // resolved → new is not allowed by default
    expect(actions.changeStatus(i.id, 'feedback')).toBe(true);
    expect(store.issueMap().get(i.id)!.resolution).toBe('reopened');
  });

  it('keeps relationships symmetric', () => {
    const a = actions.report(draft())!;
    const b = actions.report(draft())!;
    expect(actions.addRelationship(a.id, 'parent_of', b.id)).toBeNull();
    expect(store.issueMap().get(b.id)!.relationships).toEqual([{ type: 'child_of', issueId: a.id }]);
    expect(actions.addRelationship(a.id, 'related_to', b.id)).not.toBeNull(); // duplicate link rejected
    actions.removeRelationship(a.id, b.id);
    expect(store.issueMap().get(b.id)!.relationships).toEqual([]);
  });

  it('note files show up as ticket documents and survive note deletion when kept', () => {
    const i = actions.report(draft())!;
    const fileId = addPendingAttachment('log.txt');
    const note = actions.addNote(i.id, doc('see file'), false, 30, [fileId])!;
    const att = () => store.attachments().find((a) => a.id === fileId)!;
    expect(att().issueId).toBe(i.id);
    expect(att().commentId).toBe(note.id);

    actions.deleteNote(note.id, true);
    expect(att().commentId).toBeNull();
    expect(store.comments().some((c) => c.id === note.id)).toBe(false);
  });

  it('deleting a note can delete its files too', () => {
    const i = actions.report(draft())!;
    const fileId = addPendingAttachment('shot.png');
    const note = actions.addNote(i.id, doc('x'), false, 0, [fileId])!;
    actions.deleteNote(note.id, false);
    expect(store.attachments().some((a) => a.id === fileId)).toBe(false);
    expect(historyOf(i.id).some((h) => h.type === 'attachment_deleted')).toBe(true);
  });

  it('only managers can delete, and delete can be undone by restoring the snapshot', () => {
    actions.remove([1]);
    expect(store.issueMap().has(1)).toBe(true); // developer: denied
    TestBed.inject(Auth).login('mlopez', false); // manager
    const before = store.snapshot();
    actions.remove([1]);
    expect(store.issueMap().has(1)).toBe(false);
    store.restore(before);
    expect(store.issueMap().has(1)).toBe(true);
  });

  function addPendingAttachment(name: string): number {
    let id = 0;
    store.mutate((d) => {
      id = store.nextId(d);
      d.attachments.push({
        id, blobId: id, issueId: 0, commentId: null, name, description: '', mimeType: 'text/plain', size: 10, uploaderId: 3,
        date: new Date().toISOString(), version: 1, previousVersionId: null, current: true,
      });
    });
    return id;
  }
});
