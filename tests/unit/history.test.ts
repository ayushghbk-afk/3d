// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeStubSession } from '../helpers/stub-session';
import { History } from '../../src/editor/history';
import { createProjectDoc, defaultObject } from '../../src/state/models';

function seed() {
  const { session: s, doc } = makeStubSession();
  // the stub session ships a generic user; make it the author we assert on
  (s as unknown as { userId: string }).userId = 'u-me';
  (s as unknown as { userName: string }).userName = 'Ayush';
  s.history.setAuthor(() => ({ id: s.userId, name: 'Ayush' }));
  s.history.onCheckpoint = () => s.peerEdits.set(0);
  const o = defaultObject('cube', 'Cube');
  doc.objects.push(o);
  s.viewport.addObject(o);
  return { session: s, doc, cube: o };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('History: authored snapshots', () => {
  it('tags every checkpoint with the local user', () => {
    const { session: s, doc } = seed();
    s.history.checkpoint(doc, 'Add Cube');
    s.history.checkpoint(doc, 'Move Cube');
    const entries = s.history.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].label).toBe('Move Cube'); // newest first
    expect(entries[0].author).toEqual({ id: 'u-me', name: 'Ayush' });
    expect(s.history.describe(entries[0])).toBe('Move Cube · Ayush');
  });

  it('undoThrough folds several steps into one redo', () => {
    const { session: s, doc, cube } = seed();
    s.history.checkpoint(doc, 'step 1');
    cube.position = { x: 1, y: 0, z: 0 };
    s.history.checkpoint(doc, 'step 2');
    cube.position = { x: 2, y: 0, z: 0 };
    s.history.checkpoint(doc, 'step 3');
    cube.position = { x: 3, y: 0, z: 0 };

    const pos = () => doc.objects.find((o) => o.id === cube.id)!.position.x;
    expect(s.history.undoThrough(doc, 2)).toBe(true); // back to before step 1
    expect(pos()).toBe(0);
    expect(s.history.canUndo()).toBe(false);
    expect(s.history.redo(doc)).toBe(true); // one redo restores the newest state
    expect(pos()).toBe(3);
    expect(cube.id).toBe(doc.objects[0].id); // snapshots restore clones of the same object
  });

  it('depthOfMine finds my newest entry', () => {
    const doc = createProjectDoc('H', 'solo', 'guest');
    const h = new History();
    h.setAuthor(() => ({ id: 'me', name: 'Me' }));
    h.checkpoint(doc, 'mine');
    expect(h.depthOfMine('me')).toBe(0);
    h.setAuthor(() => ({ id: 'them', name: 'Them' }));
    h.checkpoint(doc, 'theirs');
    expect(h.depthOfMine('me')).toBe(1);
    expect(h.depthOfMine('them')).toBe(0);
    expect(h.depthOfMine('nobody')).toBeNull();
  });

  it('clears the peer-edit counter whenever we checkpoint', () => {
    const { session: s, doc } = seed();
    s.peerEdits.set(3);
    s.history.checkpoint(doc, 'mine');
    expect(s.peerEdits.get()).toBe(0);
  });
});

describe('collaboration-aware undo', () => {
  it('undoes instantly when no peer edited in the meantime', () => {
    const { session: s, doc, cube } = seed();
    s.history.checkpoint(doc, 'Add Cube');
    cube.position = { x: 5, y: 0, z: 0 };

    const notices: string[] = [];
    s.onNotice = (n) => notices.push(`${n.kind}:${n.msg}`);
    s.undo();

    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(0);
    expect(notices.some((n) => n.includes('Undid Add Cube · Ayush'))).toBe(true);
  });

  it('asks for confirmation when undoing would revert a collaborator', () => {
    const { session: s, doc, cube } = seed();
    s.history.checkpoint(doc, 'Add Cube');
    cube.position = { x: 5, y: 0, z: 0 };
    s.peerEdits.set(2); // Maya moved things after my checkpoint

    const notices: string[] = [];
    s.onNotice = (n) => notices.push(n.msg);

    s.undo();
    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(5); // nothing reverted yet
    expect(notices[0]).toContain('reverts 2 changes from collaborators');

    s.undo(); // second press confirms
    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(0);
    expect(s.peerEdits.get()).toBe(0);
  });

  it('the confirmation expires (a later undo asks again)', () => {
    const { session: s, doc, cube } = seed();
    s.history.checkpoint(doc, 'Add Cube');
    cube.position = { x: 5, y: 0, z: 0 };
    s.peerEdits.set(1);
    s.onNotice = () => undefined;

    s.undo(); // arms
    vi.advanceTimersByTime(9000);
    s.undo(); // arms again instead of reverting
    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(5);
    s.undo(); // confirms
    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(0);
  });

  it('force skips the confirmation (command palette / agent API)', () => {
    const { session: s, doc, cube } = seed();
    s.history.checkpoint(doc, 'Add Cube');
    cube.position = { x: 5, y: 0, z: 0 };
    s.peerEdits.set(4);
    s.onNotice = () => undefined;
    s.undo(true);
    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(0);
  });

  it('undoMine walks back to my own change and says what else is lost', () => {
    const { session: s, doc, cube } = seed();
    s.history.checkpoint(doc, 'My edit');
    cube.position = { x: 1, y: 0, z: 0 };
    s.history.setAuthor(() => ({ id: 'peer-1', name: 'Maya' }));
    s.history.checkpoint(doc, 'Maya edit');
    cube.position = { x: 2, y: 0, z: 0 };
    s.history.setAuthor(() => ({ id: 'u-me', name: 'Ayush' }));

    const notices: string[] = [];
    s.onNotice = (n) => notices.push(n.msg);
    s.undoMine();
    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(2); // untouched: needs confirmation
    expect(notices[0]).toContain('your last change is 1 step back');

    s.undoMine();
    expect(doc.objects.find((o) => o.id === cube.id)!.position.x).toBe(0);
  });

  it('undoPreview describes the pending step for tooltips', () => {
    const { session: s, doc } = seed();
    expect(s.undoPreview()).toBeNull();
    s.history.checkpoint(doc, 'Move Cube');
    expect(s.undoPreview()).toEqual({ label: 'Move Cube', author: 'Ayush', peerEdits: 0 });
    s.peerEdits.set(1);
    expect(s.undoPreview()!.peerEdits).toBe(1);
  });

  it('recentChanges is newest-first for the collaboration panel', () => {
    const { session: s, doc } = seed();
    s.history.checkpoint(doc, 'first');
    s.history.checkpoint(doc, 'second');
    const changes = s.recentChanges(5);
    expect(changes.map((c) => c.label)).toEqual(['second', 'first']);
    expect(changes[0].author).toBe('Ayush');
  });

  it('reports an empty stack instead of failing silently', () => {
    const { session: s } = seed();
    const notices: string[] = [];
    s.onNotice = (n) => notices.push(n.msg);
    s.undo();
    s.redo();
    expect(notices).toEqual(['Nothing to undo', 'Nothing to redo']);
  });
});
