// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createStarterProjectDoc, normalizeDoc, type StarterTemplate } from '../../src/state/models.js';
import { STARTER_TEMPLATES } from '../../src/ui/dashboard.js';

describe('createStarterProjectDoc', () => {
  it('keeps blank projects empty', () => {
    const doc = createStarterProjectDoc('Blank', 'solo', 'user-1', 'blank');
    expect(doc.objects).toHaveLength(0);
    expect(doc.materials).toHaveLength(1);
  });

  it('builds a product starter scene with lights and geometry', () => {
    const doc = createStarterProjectDoc('Mockup', 'solo', 'user-1', 'product');
    expect(doc.objects.some((o) => o.type === 'light')).toBe(true);
    expect(doc.objects.some((o) => o.type === 'plane')).toBe(true);
    expect(doc.objects.some((o) => o.type === 'cylinder')).toBe(true);
    expect(doc.materials.length).toBeGreaterThan(2);
  });

  it('builds a low-poly starter scene with a ground plane and atmosphere', () => {
    const doc = createStarterProjectDoc('Low Poly', 'solo', 'user-1', 'lowpoly');
    expect(doc.objects.some((o) => o.name === 'Ground')).toBe(true);
    expect(doc.objects.some((o) => o.name === 'Sun Light')).toBe(true);
    expect(doc.objects.some((o) => o.type === 'cone')).toBe(true);
  });
});

describe('starter templates (dashboard + New Project modal)', () => {
  it('lists nine templates with a title and description', () => {
    expect(STARTER_TEMPLATES).toHaveLength(9);
    for (const t of STARTER_TEMPLATES) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(10);
    }
    expect(STARTER_TEMPLATES[0].id).toBe('blank');
  });

  it('every template builds a scene the editor can open', () => {
    for (const t of STARTER_TEMPLATES) {
      const doc = createStarterProjectDoc(`T ${t.id}`, 'solo', 'user-1', t.id as StarterTemplate);
      if (t.id !== 'blank') expect(doc.objects.length, t.id).toBeGreaterThan(0);
      // parents must exist, ids unique, materials referenced must exist
      normalizeDoc(doc);
      const ids = new Set(doc.objects.map((o) => o.id));
      expect(ids.size, t.id).toBe(doc.objects.length);
      for (const o of doc.objects) {
        if (o.parentId) expect(ids.has(o.parentId), `${t.id}: ${o.name} parent`).toBe(true);
        if (o.materialId) {
          expect(doc.materials.some((m) => m.id === o.materialId), `${t.id}: ${o.name} material`).toBe(true);
        }
        expect(Number.isFinite(o.position.x) && Number.isFinite(o.position.y), `${t.id}: ${o.name} position`).toBe(true);
      }
    }
  });

  it('the game template ships physics bodies for Play Mode', () => {
    const doc = createStarterProjectDoc('Game', 'solo', 'user-1', 'game');
    const bodies = doc.objects.filter((o) => o.physics?.enabled);
    expect(bodies.length).toBeGreaterThan(2);
    expect(bodies.some((b) => b.physics?.trigger)).toBe(true); // collectibles
    expect(bodies.some((b) => !b.physics?.dynamic)).toBe(true); // ground
  });

  it('the animation template ships a clip with keyframes', () => {
    const doc = createStarterProjectDoc('Anim', 'solo', 'user-1', 'animation');
    expect(doc.clips.length).toBeGreaterThan(0);
    const clip = doc.clips[0];
    expect(clip.tracks.length).toBeGreaterThan(0);
    expect(clip.tracks[0].keyframes.length).toBeGreaterThan(1);
    const objectIds = new Set(doc.objects.map((o) => o.id));
    for (const track of clip.tracks) expect(objectIds.has(track.objectId)).toBe(true);
  });

  it('the solar template orbits every planet on a circular path', () => {
    const doc = createStarterProjectDoc('Solar', 'solo', 'user-1', 'solar');
    expect(doc.clips.length).toBeGreaterThan(0);
    const clip = doc.clips[0];
    expect(clip.name).toBe('Orbit');
    expect(clip.tracks.length).toBeGreaterThan(2);
    for (const track of clip.tracks) {
      expect(track.property).toBe('position');
      expect(track.keyframes.length).toBeGreaterThan(2);
      // every key sits on the same circle around the sun
      const radii = track.keyframes.map((k) => Math.hypot(k.value[0], k.value[2]));
      const r = radii[0];
      expect(r).toBeGreaterThan(0.5);
      for (const rad of radii) expect(rad).toBeCloseTo(r, 3);
      // … and the last key closes the loop back on the first
      const first = track.keyframes[0].value;
      const last = track.keyframes[track.keyframes.length - 1].value;
      expect(Math.hypot(last[0], last[2])).toBeCloseTo(Math.hypot(first[0], first[2]), 3);
    }
  });
});
