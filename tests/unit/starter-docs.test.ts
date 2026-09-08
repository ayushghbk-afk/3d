import { describe, expect, it } from 'vitest';
import { createStarterProjectDoc } from '../../src/state/models.js';

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
