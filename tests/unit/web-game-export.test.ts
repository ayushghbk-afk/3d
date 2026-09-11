import { describe, it, expect } from 'vitest';
// esbuild ships with vite: used to prove the generated runtime actually parses
import { transformSync } from 'esbuild';
import { buildWebGameHtml, colliderFor } from '../../src/editor/web-game-export';
import type { ObjectPhysics } from '../../src/state/models';

const physics = (patch: Partial<ObjectPhysics> = {}): ObjectPhysics => ({
  enabled: true,
  dynamic: false,
  mass: 1,
  restitution: 0,
  shape: 'box',
  trigger: false,
  ...patch,
});

const box = { center: [0, 1, 0] as [number, number, number], half: [2, 0.1, 2] as [number, number, number] };

describe('colliderFor', () => {
  it('skips objects without physics', () => {
    expect(colliderFor('Ground', null, box)).toBeNull();
    expect(colliderFor('Ground', physics({ enabled: false }), box)).toBeNull();
  });

  it('describes shape, dynamics and extents', () => {
    const c = colliderFor('Ground', physics({ shape: 'plane' }), box)!;
    expect(c).toMatchObject({ name: 'Ground', shape: 'plane', dynamic: false, trigger: false });
    expect(c.half).toEqual([2, 0.1, 2]);
    expect(c.radius).toBe(2);
    const ball = colliderFor('Ball', physics({ dynamic: true, shape: 'sphere', restitution: 0.6, mass: 3 }), box)!;
    expect(ball).toMatchObject({ dynamic: true, shape: 'sphere', restitution: 0.6, mass: 3 });
  });
});

describe('buildWebGameHtml', () => {
  const html = (opts: Parameters<typeof buildWebGameHtml>[0]) => buildWebGameHtml(opts);

  it('is a self-contained HTML page with the scene embedded', () => {
    const page = html({ title: 'My Game', glbBase64: 'AAAABBBB', hasAnimation: true });
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<title>My Game</title>');
    expect(page).toContain("const b64 = 'AAAABBBB';");
    expect(page).toContain('GLTFLoader');
    expect(page).toContain('OrbitControls');
    expect(page).toContain('animation plays automatically');
  });

  it('ships play mode: WASD, jump, pointer lock and a touch pad', () => {
    const page = html({ title: 'G', glbBase64: '' });
    expect(page).toContain('▶ Play');
    expect(page).toContain('Space');
    expect(page).toContain('KeyW');
    expect(page).toContain('requestPointerLock');
    expect(page).toContain('(pointer: coarse)'); // touch detection
    expect(page).toContain('id="pad"');
    expect(page).toContain('id="jump"');
    expect(page).toContain('Exit (Esc)');
  });

  it('bakes colliders and tuning into the page', () => {
    const page = html({
      title: 'G',
      glbBase64: '',
      colliders: [colliderFor('Ground', physics({ shape: 'plane' }), box)!],
      speed: 6,
      eyeHeight: 1.7,
      gravity: 22,
    });
    expect(page).toContain('"Ground"');
    expect(page).toContain('const SPEED = 6, EYE = 1.7, GRAVITY = 22;');
    expect(page).toContain('resolve('); // collision resolution is present
  });

  it('runs play/frame scripts in a sandbox with a small object API', () => {
    const page = html({
      title: 'G',
      glbBase64: '',
      scripts: [
        { name: 'start', trigger: 'play', code: "scene.find('Cube').move(0, 1, 0);" },
        { name: 'spin', trigger: 'frame', code: "scene.find('Cube').rotate(0, 0.01, 0);" },
      ],
    });
    expect(page).toContain('"start"');
    expect(page).toContain('scene.find(\'Cube\').move(0, 1, 0);');
    expect(page).toContain("userScripts[s.trigger].push(new Function");
    expect(page).toContain('runScripts(\'play\')');
    expect(page).toContain('runScripts(\'frame\')');
  });

  it('ignores editor-only triggers and escapes hostile script text', () => {
    const page = html({
      title: 'G',
      glbBase64: '',
      scripts: [
        { name: 'manual one', trigger: 'manual' as never, code: 'nope()' },
        { name: 'evil', trigger: 'play', code: '</script><script>alert(1)</script>' },
      ],
    });
    expect(page).not.toContain('"manual one"');
    expect(page).not.toContain('</script><script>alert(1)</script>');
  });

  it('escapes the project title', () => {
    const page = html({ title: '<img src=x onerror=alert(1)>', glbBase64: '' });
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x');
  });

  it('exposes a trigger hook for hand-written game code', () => {
    const page = html({ title: 'G', glbBase64: '' });
    expect(page).toContain('window.W3D.onTrigger');
  });

  it('generates a runtime that is syntactically valid JavaScript', () => {
    const page = html({
      title: 'G',
      glbBase64: 'AAAA',
      colliders: [colliderFor('Ground', physics({ shape: 'plane' }), box)!],
      scripts: [{ name: 'start', trigger: 'play', code: "scene.find('Ball').move(0, 2, 0);" }],
      hasAnimation: true,
    });
    const source = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(source.length).toBeGreaterThan(2000);
    expect(() => transformSync(source, { loader: 'js', format: 'esm', target: 'es2022' })).not.toThrow();
  });
});
