// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { EditorSession } from '../../src/editor/session';
import {
  createProjectDoc, defaultObject, type SceneObjectData,
} from '../../src/state/models';
import { History } from '../../src/editor/history';
import { makeStubSession } from '../helpers/stub-session';

/**
 * Group/hierarchy regressions, exercised through the real EditorSession
 * prototype with a stubbed viewport (same approach as save-state.test.ts —
 * no WebGL, no Supabase). These lock the audit fixes:
 *  - deleteObject removes the WHOLE subtree and prunes animation tracks
 *  - setParent rejects cycles (used to freeze the render loop)
 *  - duplicateObject copies children with remapped parents
 *  - groupSelection / ungroupObject behave like real outliners
 *  - undo/redo includes doc.assets (orphan fix)
 */

function makeSession() {
  const { session, doc, viewport, objects } = makeStubSession();
  return { session, doc, viewport, objects };
}

function buildTree(session: EditorSession) {
  const g = session.addObject('group', 'G');
  const c1 = session.addObject('cube', 'C1');
  const c2 = session.addObject('cube', 'C2');
  session.setParent(c1.id, g.id);
  session.setParent(c2.id, c1.id); // grandchild — the case the old code lost
  return { g, c1, c2 };
}

describe('group system — delete', () => {
  it('removes the entire subtree and prunes ghost animation tracks', () => {
    const { session, doc } = makeSession();
    const { g, c1, c2 } = buildTree(session);
    doc.clips[0].tracks.push({ id: 'k1', objectId: c2.id, property: 'position', keyframes: [{ frame: 0, value: [0, 0, 0], interp: 'linear' }] });
    doc.clips[0].tracks.push({ id: 'k2', objectId: c1.id, property: 'scale', keyframes: [{ frame: 0, value: [1, 1, 1], interp: 'linear' }] });

    session.deleteObject(g.id);

    expect(doc.objects).toHaveLength(0); // grandchildren must not survive as orphans
    expect(doc.clips[0].tracks).toHaveLength(0);
    const deletes = (session.sync.broadcastOp as ReturnType<typeof vi.fn>).mock.calls.filter(([op]) => op === 'delete');
    expect(deletes.map(([, d]) => (d as { id: string }).id).sort()).toEqual([g.id, c1.id, c2.id].sort());
  });

  it('undo restores the subtree in one step', () => {
    const { session, doc } = makeSession();
    const { g } = buildTree(session);
    session.deleteObject(g.id);
    expect(doc.objects).toHaveLength(0);
    session.undo();
    expect(doc.objects).toHaveLength(3);
    expect(doc.objects.find((o) => o.id === g.id)).toBeTruthy();
  });
});

describe('group system — parenting', () => {
  it('refuses to parent an object inside its own descendant (cycle freeze)', () => {
    const { session, doc } = makeSession();
    const { g, c2 } = buildTree(session);
    const notices: string[] = [];
    session.onNotice = (n) => notices.push(n.msg);

    session.setParent(g.id, c2.id);
    expect(doc.objects.find((o) => o.id === g.id)?.parentId).toBeNull();
    expect(notices.join(' ')).toContain('Cannot parent');
  });

  it('groupSelection wraps the current selection; ungroupObject dissolves it', () => {
    const { session, doc } = makeSession();
    const cube = session.addObject('cube', 'Cube');
    session.select(cube.id);

    const group = session.groupSelection();
    expect(doc.objects.find((o) => o.id === cube.id)?.parentId).toBe(group.id);
    expect(doc.objects.find((o) => o.id === group.id)?.type).toBe('group');

    session.select(group.id);
    session.ungroupObject(group.id);
    expect(doc.objects.find((o) => o.id === group.id)).toBeUndefined();
    expect(doc.objects.find((o) => o.id === cube.id)?.parentId).toBeNull();
  });

  it('preserves world position when parenting (local bake)', () => {
    const { session, doc } = makeSession();
    const g = session.addObject('group', 'G');
    const cube = session.addObject('cube', 'Cube');
    session.setTransform(cube.id, { x: 5, y: 1, z: -2 });
    session.setParent(cube.id, g.id);
    const c = doc.objects.find((o) => o.id === cube.id)!;
    expect([c.position.x, c.position.y, c.position.z]).toEqual([5, 1, -2]); // G is identity
    expect(c.parentId).toBe(g.id);
  });
});

describe('group system — duplicate', () => {
  it('copies children with remapped parents and fresh ids', () => {
    const { session, doc } = makeSession();
    const { g, c1, c2 } = buildTree(session);
    const before = doc.objects.length;

    const copy = session.duplicateObject(g.id)!;
    expect(doc.objects).toHaveLength(before + 3);
    expect(copy.name).toBe('G copy');
    const kids = doc.objects.filter((o) => o.parentId === copy.id);
    expect(kids).toHaveLength(1);
    const grandKids = doc.objects.filter((o) => o.parentId === kids[0].id);
    expect(grandKids).toHaveLength(1);
    expect(grandKids[0].id).not.toBe(c2.id);
    // originals untouched
    expect(doc.objects.find((o) => o.id === c1.id)?.parentId).toBe(g.id);
    void c2;
  });
});

describe('history covers assets', () => {
  it('undo of an import removes the orphaned asset metadata; redo brings it back', () => {
    const doc = createProjectDoc('T', 'solo', 'guest');
    const h = new History();
    h.checkpoint(doc, 'before');
    doc.assets.push({
      id: 'a1', name: 'chair.glb', kind: 'model', mime: 'model/gltf-binary',
      size: 10, storagePath: null, local: true, thumb: null, createdAt: 'now',
    });
    expect(doc.assets).toHaveLength(1);
    h.undo(doc);
    expect(doc.assets).toHaveLength(0); // used to stay → shipped in every GitHub export
    h.redo(doc);
    expect(doc.assets[0]?.id).toBe('a1');
  });
});
