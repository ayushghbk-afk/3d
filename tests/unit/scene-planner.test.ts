// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  planSceneLocally,
  sanitizePlan,
  expandPlan,
  describePlan,
  extractJson,
} from '../../src/ai/scene-planner';

describe('local scene planner', () => {
  it('composes a sci-fi room with a desk, two monitors, neon and a chair', () => {
    const plan = planSceneLocally(
      'create a small sci-fi room with a desk, computer, two monitors, blue neon lights and a chair',
    );
    expect(plan.source).toBe('local');
    expect(plan.title).toBe('Sci-fi room');
    expect(plan.environment).toBe('cyberpunk');
    const names = plan.objects.map((o) => o.name.toLowerCase());
    expect(names.some((n) => n.includes('floor'))).toBe(true);
    expect(names.some((n) => n.includes('desk'))).toBe(true);
    // "two monitors" → two screens, each with its own panel + stand
    expect(plan.objects.filter((o) => /^Monitor \d+$/.test(o.name))).toHaveLength(2);
    expect(plan.objects.filter((o) => /^Screen \d+$/.test(o.name))).toHaveLength(2);
    expect(names.some((n) => n.includes('chair'))).toBe(true);
    expect(plan.objects.filter((o) => o.kind === 'light').length).toBeGreaterThan(0);
    // neon asks for bloom
    expect(plan.postfx?.bloom).toBeGreaterThan(0);
    // "blue" is honoured in the neon colour: blue channel dominates
    const neon = plan.objects.find((o) => o.name.toLowerCase().includes('neon'))!;
    const hex = neon.color!.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    expect(b).toBeGreaterThan(r);
    expect(neon.emissive).toBe(neon.color);
  });

  it('builds a solar system with one light per sun and orbit rings', () => {
    const plan = planSceneLocally('a solar system with 4 planets');
    expect(plan.title).toBe('Solar system');
    expect(plan.environment).toBe('void');
    const planets = plan.objects.filter((o) => /^(Mercury|Venus|Earth|Mars|Jupiter)$/.test(o.name));
    expect(planets).toHaveLength(4);
    expect(plan.objects.some((o) => o.kind === 'light')).toBe(true);
  });

  it('scales a room down when the prompt says small', () => {
    const small = planSceneLocally('a small room with a bed');
    const large = planSceneLocally('a large room with a bed');
    const span = (plan: ReturnType<typeof planSceneLocally>) => {
      const floor = plan.objects.find((o) => o.name.toLowerCase().includes('floor'))!;
      return Math.max(floor.scale![0], floor.scale![2]);
    };
    expect(span(small)).toBeLessThan(span(large));
  });

  it('every local plan is valid enough for the session to apply', () => {
    for (const prompt of [
      'low poly forest with 12 trees',
      'product showcase podium',
      'a chair',
      'cyberpunk alley at night',
      'solar system',
    ]) {
      const plan = planSceneLocally(prompt);
      expect(sanitizePlan(plan, plan.title)?.objects.length).toBeGreaterThan(0);
      expect(expandPlan(plan).length).toBeGreaterThan(0);
      expect(describePlan(plan).length).toBeGreaterThan(0);
    }
  });
});

describe('sanitizePlan (LLM output guard)', () => {
  it('rejects junk', () => {
    expect(sanitizePlan(null)).toBeNull();
    expect(sanitizePlan('nope')).toBeNull();
    expect(sanitizePlan({ objects: [] })).toBeNull();
    expect(sanitizePlan({ objects: [{ kind: 'dragon' }] })).toBeNull(); // unknown kind
  });

  it('clamps values and drops invalid fields', () => {
    const plan = sanitizePlan({
      title: 'X'.repeat(200),
      objects: [
        { id: 'a', name: 'A', kind: 'cube', position: [1e9, -1e9, 1], scale: [0, 0, 999], color: 'red', preset: 'unobtanium', emissiveIntensity: 500 },
      ],
    })!;
    expect(plan.title).toHaveLength(80);
    const o = plan.objects[0];
    expect(o.position).toEqual([40, -40, 1]);
    expect(o.scale).toEqual([0.02, 0.02, 40]);
    expect(o.color).toBeUndefined(); // not a hex colour
    expect(o.preset).toBeUndefined();
    expect(o.emissiveIntensity).toBe(6);
  });

  it('breaks parenting cycles and dangling parents', () => {
    const plan = sanitizePlan({
      objects: [
        { id: 'a', kind: 'cube', parent: 'b' },
        { id: 'b', kind: 'cube', parent: 'a' },
        { id: 'c', kind: 'cube', parent: 'ghost' },
      ],
    })!;
    const byId = new Map(plan.objects.map((o) => [o.id, o]));
    expect(byId.get('c')!.parent).toBeNull(); // parent does not exist → orphaned at root
    // a↔b was a cycle: at least one link must be cut so the tree terminates
    for (const start of plan.objects) {
      const seen = new Set<string>();
      let cur: (typeof plan.objects)[number] | undefined = start;
      let hops = 0;
      while (cur && hops++ < 64) {
        expect(seen.has(cur.id)).toBe(false);
        seen.add(cur.id);
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
    }
  });

  it('caps repeat counts', () => {
    const plan = sanitizePlan({ objects: [{ id: 'r', kind: 'cone', repeat: { count: 500, radius: 900 } }] })!;
    expect(plan.objects[0].repeat!.count).toBe(24);
    expect(plan.objects[0].repeat!.radius).toBe(40);
    expect(plan.objects[0].repeat!.axis).toBe('y');
  });
});

describe('expandPlan + describePlan', () => {
  it('expands repeats into concrete objects with unique ids', () => {
    const plan = sanitizePlan({
      title: 'Ring',
      objects: [
        { id: 'pillar', name: 'Pillar', kind: 'cylinder', repeat: { count: 4, radius: 3 } },
      ],
    })!;
    const concrete = expandPlan(plan);
    expect(concrete).toHaveLength(4);
    expect(new Set(concrete.map((c) => c.tempId)).size).toBe(4);
    const xs = concrete.map((c) => Number((c.position?.x ?? 0).toFixed(3)));
    expect(new Set(xs).size).toBeGreaterThan(1); // spread around the ring
  });

  it('parents children by temp id', () => {
    const plan = sanitizePlan({
      objects: [
        { id: 'table', name: 'Table', kind: 'cube' },
        { id: 'lamp', name: 'Lamp', kind: 'sphere', parent: 'table', position: [0, 1, 0] },
      ],
    })!;
    const concrete = expandPlan(plan);
    const table = concrete.find((c) => c.name === 'Table')!;
    const lamp = concrete.find((c) => c.name === 'Lamp')!;
    expect(lamp.parentTempId).toBe(table.tempId);
    expect(lamp.position?.y).toBeCloseTo(1, 5);
  });

  it('describePlan summarises objects and lights for the chat transcript', () => {
    const plan = planSceneLocally('a small sci-fi room with a desk and blue neon lights');
    const text = describePlan(plan);
    expect(text).toMatch(/\d+ objects/);
    expect(text).toMatch(/\d+ lights/);
    expect(text).toContain('cyberpunk'); // environment is surfaced in the summary
  });
});

describe('extractJson', () => {
  it('reads fenced and raw JSON, ignoring prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('sure! {"objects":[{"id":"x","kind":"cube"}]} hope that helps'))
      .toEqual({ objects: [{ id: 'x', kind: 'cube' }] });
    expect(extractJson('no json here')).toBeNull();
  });
});
