// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { EditorSession } from '../../src/editor/session';
import { makeStubSession } from '../helpers/stub-session';

/**
 * "Apply texture to what I selected" regressions.
 *
 * Every new primitive used to start on the SAME shared `Default` material, so
 * texturing/painting one object recoloured the whole scene. The fix:
 * `makeSelectionMaterialsUnique` gives the selection private copies of any
 * material that is also used outside the selection, and every "apply to
 * selection" entry point goes through it.
 */

function makeSession() {
  const { session, doc, viewport } = makeStubSession();
  const a = session.addPrimitive('cube');
  const b = session.addPrimitive('cube');
  // both primitives start on the shared Default material — that's the trap
  expect(a.materialId).toBe(b.materialId);
  (session as unknown as { hydrateTextures: unknown }).hydrateTextures = vi.fn();
  return { session, doc, viewport, a, b, sharedId: a.materialId as string };
}

describe('makeSelectionMaterialsUnique', () => {
  it('gives a selected object its own material copy (shared one stays put)', () => {
    const { session, doc, a, b, sharedId } = makeSession();
    session.select(a.id);
    const mats = session.makeSelectionMaterialsUnique();
    expect(mats).toHaveLength(1);
    expect(mats[0].id).not.toBe(sharedId);
    expect(mats[0].name).toBe('Default copy');
    expect(a.materialId).toBe(mats[0].id);
    expect(b.materialId).toBe(sharedId); // untouched
    expect(doc.materials).toHaveLength(2);
  });

  it('keeps genuinely selected-only materials as-is (no pointless copies)', () => {
    const { session, doc, a, sharedId } = makeSession();
    session.select(a.id);
    const mats = session.makeSelectionMaterialsUnique();
    const again = session.makeSelectionMaterialsUnique();
    expect(again.map((m) => m.id)).toEqual(mats.map((m) => m.id)); // idempotent
    expect(doc.materials).toHaveLength(2); // still just Default + the one copy
    expect(doc.materials.find((m) => m.id === sharedId)).toBeTruthy();
  });

  it('multi-selecting ALL users keeps the material shared', () => {
    const { session, doc, a, b, sharedId } = makeSession();
    session.selectIds([a.id, b.id]);
    const mats = session.makeSelectionMaterialsUnique();
    expect(mats.map((m) => m.id)).toEqual([sharedId]);
    expect(doc.materials).toHaveLength(1);
    expect(a.materialId).toBe(sharedId);
    expect(b.materialId).toBe(sharedId);
  });

  it('returns [] with nothing selected', () => {
    const { session, doc } = makeSession();
    session.select(null);
    expect(session.makeSelectionMaterialsUnique()).toEqual([]);
    expect(doc.materials).toHaveLength(1);
  });

  it('is undoable in one step', () => {
    const { session, a, b, sharedId } = makeSession();
    session.select(a.id);
    session.makeSelectionMaterialsUnique();
    expect(a.materialId).not.toBe(sharedId);
    session.undo();
    // undo swaps in restored rows — look them up fresh by id
    expect(session.doc.materials).toHaveLength(1);
    expect(session.doc.objects.find((o) => o.id === a.id)?.materialId).toBe(sharedId);
    expect(session.doc.objects.find((o) => o.id === b.id)?.materialId).toBe(sharedId);
  });
});

describe('apply texture / preset to selection', () => {
  it('texturing the selection does not recolour the rest of the scene', () => {
    const { session, a, b, sharedId } = makeSession();
    session.select(a.id);
    session.setMaterialMap(session.makeSelectionMaterialsUnique()[0].id, 'base', 'asset-1');
    const def = session.doc.materials.find((m) => m.id === sharedId);
    expect(def?.mapAssetId).toBeNull(); // b stays untextured
    expect(a.materialId).not.toBe(sharedId);
    expect(session.doc.materials.find((m) => m.id === a.materialId)?.mapAssetId).toBe('asset-1');
  });

  it('preset paint hits only the selected object', () => {
    const { session, a, b, sharedId } = makeSession();
    session.select(a.id);
    const n = session.applyMaterialPresetToSelection('gold');
    expect(n).toBe(1);
    const selMat = session.doc.materials.find((m) => m.id === a.materialId);
    const otherMat = session.doc.materials.find((m) => m.id === b.materialId);
    expect(selMat?.metalness).toBe(1); // gold
    expect(otherMat?.id).toBe(sharedId);
    expect(otherMat?.metalness).toBe(0.1); // default — untouched
    expect(session.selectedObjects()[0].id).toBe(a.id);
  });

  it('preset paint on a multi-select sharing one material edits it in place once', () => {
    const { session, doc, a, b, sharedId } = makeSession();
    session.selectIds([a.id, b.id]);
    const n = session.applyMaterialPresetToSelection('gold');
    expect(n).toBe(1);
    expect(doc.materials).toHaveLength(1);
    expect(doc.materials[0].id).toBe(sharedId);
    expect(doc.materials[0].metalness).toBe(1);
  });
});
