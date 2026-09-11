// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { SCENE_STYLES, findStyle, styleById, applyStyle } from '../../src/ai/style';
import { createProjectDoc, defaultMaterial, defaultObject } from '../../src/state/models';
import type { ProjectDoc } from '../../src/state/models';

function docWithContent(): ProjectDoc {
  const doc = createProjectDoc('Style me', 'solo', 'guest');
  for (let i = 0; i < 4; i++) {
    const m = defaultMaterial(`Mat ${i + 1}`);
    doc.materials.push(m);
    const o = defaultObject('cube', `Cube ${i + 1}`);
    o.materialId = m.id;
    doc.objects.push(o);
  }
  const lamp = defaultObject('light', 'Lamp');
  lamp.position = { x: 2, y: 4, z: 2 };
  doc.objects.push(lamp);
  return doc;
}

describe('scene style catalogue', () => {
  it('every style is complete enough to apply', () => {
    expect(SCENE_STYLES.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(SCENE_STYLES.map((s) => s.id));
    expect(ids.size).toBe(SCENE_STYLES.length);
    for (const s of SCENE_STYLES) {
      expect(s.palette.length).toBeGreaterThan(0);
      expect(s.lights.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.environment).toBeTruthy();
      for (const c of [...s.palette, ...s.lights.map((l) => l.color)]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('findStyle reads a restyle request', () => {
    const style = findStyle('make this scene look like a cyberpunk game');
    expect(style?.id).toBe('cyberpunk');
    expect(findStyle('warm sunset please')?.id).toBe('sunset');
    expect(findStyle('scary dark woods')?.id).toBeTruthy();
    expect(findStyle('nothing in particular here') ?? null).toBeNull();
  });

  it('styleById falls back to the first style', () => {
    expect(styleById('night').id).toBe('night');
    expect(styleById('does-not-exist' as never).id).toBe(SCENE_STYLES[0].id);
  });
});

describe('applyStyle', () => {
  it('remaps materials, presentation and lights', () => {
    const doc = docWithContent();
    const style = styleById('cyberpunk');
    const out = applyStyle(doc, style);

    expect(out.materials).toBe(doc.materials.length); // every material restyled
    expect(out.lights).toBe(style.lights.length);
    doc.materials.forEach((m, i) => {
      expect(m.baseColor).toBe(style.palette[i % style.palette.length]);
      expect(m.metalness).toBe(style.metalness);
      expect(m.roughness).toBe(style.roughness);
    });
    expect(doc.settings.environment?.preset).toBe(style.environment);
    expect(doc.settings.environment?.background).toBe(style.background);
    expect(doc.settings.fog).toEqual(style.fog);
    expect(doc.settings.postfx).toEqual(style.postfx);
  });

  it('reuses existing lights in place and trims the extras', () => {
    const doc = docWithContent();
    const style = styleById('studio');
    for (let i = 0; i < 4; i++) doc.objects.push(defaultObject('light', `Extra ${i}`));
    const before = doc.objects.filter((o) => o.type === 'light').length;
    expect(before).toBe(5);

    applyStyle(doc, style);
    const lights = doc.objects.filter((o) => o.type === 'light');
    expect(lights).toHaveLength(style.lights.length);
    expect(lights[0].name).toBe('Lamp'); // existing light reused, not deleted
    expect(lights[0].position).toEqual({ x: 2, y: 4, z: 2 }); // placement preserved
    lights.forEach((l, i) => {
      expect(l.light!.kind).toBe(style.lights[i].kind);
      expect(l.light!.intensity).toBe(style.lights[i].intensity);
    });
  });

  it('adds missing lights when the scene has none', () => {
    const doc = createProjectDoc('Dark', 'solo', 'guest');
    const style = styleById('sunset');
    applyStyle(doc, style);
    const lights = doc.objects.filter((o) => o.type === 'light');
    expect(lights).toHaveLength(style.lights.length);
    expect(lights[0].light!.castShadow).toBe(true);
  });

  it('relight: false leaves the lighting alone', () => {
    const doc = docWithContent();
    const style = styleById('horror');
    const before = doc.objects.filter((o) => o.type === 'light').map((o) => ({ ...o.light! }));
    applyStyle(doc, style, { relight: false });
    const after = doc.objects.filter((o) => o.type === 'light').map((o) => ({ ...o.light! }));
    expect(after).toEqual(before);
    expect(doc.settings.environment?.preset).toBe(style.environment); // presentation still changes
  });

  it('is idempotent (restyling twice is a no-op)', () => {
    const doc = docWithContent();
    const style = styleById('clay');
    // `updatedAt` is a wall-clock stamp, so compare the styling only
    const snapshot = (): unknown => ({
      m: doc.materials.map(({ updatedAt: _updatedAt, ...rest }) => rest),
      s: doc.settings,
    });
    applyStyle(doc, style);
    const first = JSON.stringify(snapshot());
    applyStyle(doc, style);
    expect(JSON.stringify(snapshot())).toBe(first);
  });

  it('only makes a share of the materials emissive', () => {
    const doc = docWithContent();
    const style = styleById('cyberpunk');
    applyStyle(doc, style);
    const lit = doc.materials.filter((m) => m.emissiveIntensity > 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThanOrEqual(doc.materials.length);
    expect(lit.every((m) => style.emissive!.colors.includes(m.emissive!))).toBe(true);
  });
});
