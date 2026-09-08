import { describe, it, expect } from 'vitest';
import { createProjectDoc, defaultObject, type ProjectDoc } from '../../src/state/models.js';
import { analyzeScene, planPaint, planTidy, MODEL_PROFILES } from '../../src/ai/scene-iq.js';

function buildDoc(): ProjectDoc {
  const doc = createProjectDoc('IQ Test', 'solo', 'guest');
  const chair = defaultObject('group', 'Wooden chair');
  doc.objects.push(chair);
  for (const n of ['Seat', 'Backrest', 'Leg front', 'Leg back']) {
    const p = defaultObject('cube', n);
    p.parentId = chair.id;
    doc.objects.push(p);
  }
  const car = defaultObject('group', 'Red car');
  doc.objects.push(car);
  for (const n of ['Body', 'Wheel FL', 'Wheel FR', 'Windshield']) {
    const p = defaultObject('cube', n);
    p.parentId = car.id;
    doc.objects.push(p);
  }
  doc.objects.push(defaultObject('cube', 'Mystery blade'));
  return doc;
}

describe('scene-iq', () => {
  it('identifies models by looking at their groups', () => {
    const { groups, summary } = analyzeScene(buildDoc());
    expect(groups).toHaveLength(3);
    const chair = groups.find((g) => g.groupName === 'Wooden chair');
    const car = groups.find((g) => g.groupName === 'Red car');
    const blade = groups.find((g) => g.groupId === null);
    expect(chair?.label).toBe('chair');
    expect(chair?.confidence).toBeGreaterThan(0.5);
    expect(car?.label).toBe('car');
    expect(blade?.label).toBe('sword');
    expect(summary).toContain('3 models');
    expect(summary).toContain('chair');
  });

  it('assigns part roles with palette styles', () => {
    const { groups } = analyzeScene(buildDoc());
    const chair = groups.find((g) => g.groupName === 'Wooden chair');
    const roles = Object.fromEntries((chair?.parts ?? []).map((p) => [p.name, p.role]));
    expect(roles).toMatchObject({ Seat: 'seat', Backrest: 'seat', 'Leg front': 'legs', 'Leg back': 'legs' });
    const car = groups.find((g) => g.groupName === 'Red car');
    const carRoles = Object.fromEntries((car?.parts ?? []).map((p) => [p.name, p.role]));
    expect(carRoles).toMatchObject({ Body: 'body', 'Wheel FL': 'wheels', 'Wheel FR': 'wheels', Windshield: 'glass' });
    // Every styled part carries a concrete hex color for the paint plan.
    for (const g of groups) {
      for (const p of g.parts) {
        if (p.role !== 'keep') expect(p.style?.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('leaves unrecognized parts alone (role keep)', () => {
    const doc = createProjectDoc('Odd', 'solo', 'guest');
    const g = defaultObject('group', 'Xyzzy');
    doc.objects.push(g);
    const p = defaultObject('cube', 'Wobble');
    p.parentId = g.id;
    doc.objects.push(p);
    const { groups } = analyzeScene(doc);
    expect(groups[0].label).toBe('object');
    expect(groups[0].parts[0].role).toBe('keep');
    expect(planPaint(doc)).toHaveLength(0);
  });

  it('plans paint with scoped group filter + texture prompts', () => {
    const doc = buildDoc();
    const all = planPaint(doc);
    expect(all.length).toBe(9); // 4 chair + 4 car + 1 blade
    const chairId = doc.objects.find((o) => o.name === 'Wooden chair')?.id;
    const scoped = planPaint(doc, [chairId as string]);
    expect(scoped).toHaveLength(4);
    expect(scoped.every((i) => i.groupLabel === 'chair')).toBe(true);
    const legs = scoped.find((i) => i.role === 'legs');
    expect(legs?.patch.baseColor).toBe('#5a3d22');
    expect(legs?.texturePrompt).toContain('walnut');
    // Profile coverage: every profile has a catch-all so models paint fully.
    for (const profile of MODEL_PROFILES) {
      expect(profile.roles.length).toBeGreaterThan(0);
    }
  });

  it('plans a tidy grid over top-level models', () => {
    const doc = buildDoc();
    const plan = planTidy(doc);
    expect(plan.items).toHaveLength(3); // chair group + car group + loose blade
    expect(plan.cols).toBe(2);
    expect(plan.spacing).toBe(3.5);
    expect(plan.items.map((i) => [i.x, i.z])).toEqual([[0, 0], [3.5, 0], [0, 3.5]]);
    const wide = planTidy(doc, 10);
    expect(wide.items[1]).toMatchObject({ x: 10, z: 0 });
    const clamped = planTidy(doc, 999);
    expect(clamped.spacing).toBe(50);
  });

  it('handles an empty scene', () => {
    const doc = createProjectDoc('Empty', 'solo', 'guest');
    const { groups, summary } = analyzeScene(doc);
    expect(groups).toHaveLength(0);
    expect(summary).toContain('empty');
    expect(planPaint(doc)).toHaveLength(0);
    expect(planTidy(doc).items).toHaveLength(0);
  });
});
