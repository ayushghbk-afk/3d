import type {
  MaterialPresetId, ObjectType, PrimitiveType, SceneObjectData, Vec3, LightKind,
} from '../state/models.js';
import { materialPreset } from '../state/models.js';
import { uid } from '../lib/utils.js';

/**
 * Scene-aware AI: turn a sentence into a structured scene plan.
 *
 * Two layers, both offline-safe:
 *  1. `planSceneLocally` — a deterministic rules composer that understands a
 *     useful vocabulary (rooms, desks, monitors, chairs, neon, forests, solar
 *     systems…). Always available, fast, no key required.
 *  2. `planSceneWithLlm` — asks the configured chat provider for JSON in the
 *     same schema and validates it hard (unknown kinds/sizes are rejected or
 *     clamped). Falls back to the local composer on any failure.
 */

export interface PlannedObject {
  /** Local id inside the plan; children reference their parent by this. */
  id: string;
  name: string;
  kind: PrimitiveType | 'group' | 'light';
  parent?: string | null;
  position?: [number, number, number];
  rotation?: [number, number, number]; // degrees
  scale?: [number, number, number];
  color?: string;
  preset?: MaterialPresetId;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  light?: { kind: LightKind; intensity?: number; color?: string; distance?: number };
  /** Repeat the object N times around the Y axis (rings, forests, arrays). */
  repeat?: { count: number; radius?: number; axis?: 'x' | 'y' | 'z'; spacing?: number };
}

export interface ScenePlan {
  title: string;
  notes?: string;
  objects: PlannedObject[];
  environment?: 'room' | 'studio' | 'sunset' | 'night' | 'overcast' | 'cyberpunk' | 'forest' | 'void';
  fog?: { color: string; near: number; far: number } | null;
  postfx?: { bloom?: number; vignette?: number } | null;
  source: 'local' | 'llm';
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

function hex(node: PlannedObject, fallback: string): string {
  return typeof node.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(node.color) ? node.color : fallback;
}

const v = (a?: [number, number, number], fallback: [number, number, number] = [0, 0, 0]): [number, number, number] => {
  if (!Array.isArray(a) || a.length !== 3) return fallback;
  return [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0];
};

// ---------------------------------------------------------------------------
// Local (deterministic) composer
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1, single: 1, couple: 2, pair: 2, few: 3, several: 4, dozen: 12,
};

function countFor(prompt: string, noun: string, fallback = 1): number {
  const re = new RegExp(`(?:(two|three|four|five|six|seven|eight|nine|ten|\\d+))\\s+(?:\\w+\\s+){0,2}${noun}`, 'i');
  const m = prompt.match(re);
  if (!m) {
    const digit = prompt.match(new RegExp(`(\\d+)\\s*x?\\s*${noun}`, 'i'));
    return digit ? clamp(parseInt(digit[1], 10) || fallback, 1, 24) : fallback;
  }
  const raw = m[1].toLowerCase();
  const n = NUMBER_WORDS[raw] ?? parseInt(raw, 10);
  return clamp(Number.isFinite(n) ? n : fallback, 1, 24);
}

function pickColor(prompt: string, fallback: string): string {
  const named: [RegExp, string][] = [
    [/\b(red|crimson|scarlet)\b/i, '#e05252'],
    [/\b(blue|azure|cobalt)\b/i, '#4f8cff'],
    [/\b(green|emerald|lime)\b/i, '#4ade80'],
    [/\b(yellow|gold|amber)\b/i, '#f5c542'],
    [/\b(purple|violet|magenta)\b/i, '#a855f7'],
    [/\b(pink|rose)\b/i, '#ff7ad9'],
    [/\b(orange)\b/i, '#fb923c'],
    [/\b(white|snow)\b/i, '#f1f5f9'],
    [/\b(black|dark|charcoal)\b/i, '#1c2028'],
    [/\b(grey|gray|silver)\b/i, '#94a3b8'],
    [/\b(wood|wooden|brown|walnut|oak)\b/i, '#8b5e34'],
    [/\b(neon|cyan|electric)\b/i, '#22e0ff'],
  ];
  for (const [re, color] of named) if (re.test(prompt)) return color;
  const hexHit = prompt.match(/#[0-9a-f]{6}\b/i);
  return hexHit ? hexHit[0] : fallback;
}

function envFor(prompt: string): ScenePlan['environment'] {
  if (/cyberpunk|neon|synthwave|Blade Runner/i.test(prompt)) return 'cyberpunk';
  if (/forest|jungle|woods|trees?/i.test(prompt)) return 'forest';
  if (/sunset|dusk|golden hour/i.test(prompt)) return 'sunset';
  if (/night|dark|moonlit|space|solar|planet/i.test(prompt)) return 'void';
  if (/overcast|cloudy|foggy|misty/i.test(prompt)) return 'overcast';
  if (/studio|product|showcase|clean/i.test(prompt)) return 'studio';
  if (/room|interior|office|apartment|house|kitchen|bedroom/i.test(prompt)) return 'room';
  return undefined;
}

/** Build a room shell (floor, walls, ceiling). */
function roomShell(width: number, depth: number, height: number, floorColor: string, wallColor: string, ceiling = true): PlannedObject[] {
  const roomId = 'room';
  const out: PlannedObject[] = [
    {
      id: roomId,
      name: 'Room',
      kind: 'group',
    },
    { id: 'floor', name: 'Floor', kind: 'plane', parent: roomId, rotation: [-90, 0, 0], scale: [width, 1, depth], color: floorColor, preset: 'matte' },
    { id: 'wall-back', name: 'Wall Back', kind: 'plane', parent: roomId, position: [0, height / 2, -depth / 2], scale: [width, height, 1], color: wallColor, preset: 'matte' },
    { id: 'wall-left', name: 'Wall Left', kind: 'plane', parent: roomId, position: [-width / 2, height / 2, 0], rotation: [0, 90, 0], scale: [depth, height, 1], color: wallColor, preset: 'matte' },
    { id: 'wall-right', name: 'Wall Right', kind: 'plane', parent: roomId, position: [width / 2, height / 2, 0], rotation: [0, -90, 0], scale: [depth, height, 1], color: wallColor, preset: 'matte' },
  ];
  if (ceiling) {
    out.push({ id: 'ceiling', name: 'Ceiling', kind: 'plane', parent: roomId, position: [0, height, 0], rotation: [90, 0, 0], scale: [width, 1, depth], color: wallColor, preset: 'matte' });
  }
  return out;
}

function deskSetup(prompt: string): { objects: PlannedObject[]; monitors: number } {
  const accent = pickColor(prompt, '#7c99ff');
  const monitors = countFor(prompt, 'monitor', /two monitor|2 monitor|dual/i.test(prompt) ? 2 : 1);
  const wood = /glass|metal|steel/i.test(prompt) ? '#9aa5b5' : '#8b5e34';
  const objects: PlannedObject[] = [
    { id: 'desk', name: 'Desk', kind: 'cube', preset: 'wood', color: wood, position: [0, 0.36, -1.6], scale: [2.6, 0.08, 1.1] },
    { id: 'desk-leg-l', name: 'Desk Leg L', kind: 'cube', preset: 'wood', color: wood, position: [-1.15, 0.18, -1.6], scale: [0.1, 0.72, 1] },
    { id: 'desk-leg-r', name: 'Desk Leg R', kind: 'cube', preset: 'wood', color: wood, position: [1.15, 0.18, -1.6], scale: [0.1, 0.72, 1] },
    { id: 'computer', name: 'Computer', kind: 'cube', preset: 'plastic', color: '#232833', position: [0.85, 0.62, -1.75], scale: [0.42, 0.5, 0.6] },
  ];
  for (let i = 0; i < monitors; i++) {
    const spread = monitors === 1 ? 0 : (i - (monitors - 1) / 2) * 1.05;
    objects.push(
      { id: `monitor-${i + 1}`, name: `Monitor ${i + 1}`, kind: 'cube', preset: 'plastic', color: '#151a22', position: [spread, 0.95, -1.95], scale: [0.98, 0.56, 0.06] },
      { id: `screen-${i + 1}`, name: `Screen ${i + 1}`, kind: 'plane', preset: 'neon', color: accent, emissive: accent, emissiveIntensity: 0.9, position: [spread, 0.95, -1.915], scale: [0.9, 0.48, 1] },
      { id: `monitor-stand-${i + 1}`, name: `Monitor Stand ${i + 1}`, kind: 'cylinder', preset: 'metal', color: '#3a4150', position: [spread, 0.56, -1.95], scale: [0.08, 0.28, 0.08] },
    );
  }
  objects.push(
    { id: 'keyboard', name: 'Keyboard', kind: 'cube', preset: 'plastic', color: '#2b3140', position: [0, 0.42, -1.15], scale: [0.9, 0.03, 0.3] },
    { id: 'chair', name: 'Chair', kind: 'cube', preset: 'fabric', color: '#3f4a63', position: [0, 0.28, -0.5], scale: [0.6, 0.08, 0.6] },
    { id: 'chair-back', name: 'Chair Back', kind: 'cube', preset: 'fabric', color: '#3f4a63', position: [0, 0.6, -0.2], scale: [0.6, 0.6, 0.08] },
    { id: 'chair-post', name: 'Chair Post', kind: 'cylinder', preset: 'metal', color: '#4a5262', position: [0, 0.15, -0.5], scale: [0.06, 0.3, 0.06] },
  );
  return { objects, monitors };
}

/**
 * Deterministic prompt → plan. Recognises a practical vocabulary and always
 * returns something buildable (so the feature never dead-ends offline).
 */
export function planSceneLocally(prompt: string): ScenePlan {
  const p = prompt.toLowerCase();
  const objects: PlannedObject[] = [];
  let title = 'Generated scene';
  let environment = envFor(p);
  let fog: ScenePlan['fog'] = null;
  let postfx: ScenePlan['postfx'] = null;
  const notes: string[] = [];

  const isRoom = /room|interior|office|apartment|studio apartment|bedroom|kitchen|cabin|bunker|lab/i.test(p);
  const isSciFi = /sci-?fi|cyberpunk|futuristic|space ?station|starship/i.test(p);
  const neon = isSciFi || /neon|glow/i.test(p);
  const neonColor = /magenta|pink/i.test(p) ? '#ff4fc3' : pickColor(p, '#22e0ff');

  if (isRoom || isSciFi) {
    const width = /small|tiny|cozy/i.test(p) ? 5 : /large|big|huge|spacious/i.test(p) ? 10 : 7;
    const depth = Math.round(width * 0.85);
    const height = /low ceiling/i.test(p) ? 2.4 : 3;
    const floorColor = pickColor(p, isSciFi ? '#171b26' : '#7a5c3e');
    const wallColor = isSciFi ? '#20262f' : '#d8d2c6';
    title = isSciFi ? 'Sci-fi room' : 'Room interior';
    objects.push(...roomShell(width, depth, height, floorColor, wallColor));
    environment = environment ?? (isSciFi ? 'cyberpunk' : 'room');

    if (/desk|computer|workstation|office|monitor/i.test(p)) {
      const { objects: deskObjects } = deskSetup(p);
      objects.push(...deskObjects);
    }
    if (/bed/i.test(p)) {
      objects.push(
        { id: 'bed', name: 'Bed', kind: 'cube', preset: 'fabric', color: '#5b6b8c', position: [-width / 2 + 1.6, 0.3, depth / 2 - 1.6], scale: [2, 0.4, 1.4] },
        { id: 'pillow', name: 'Pillow', kind: 'cube', preset: 'fabric', color: '#dfe6f2', position: [-width / 2 + 0.9, 0.58, depth / 2 - 1.6], scale: [0.6, 0.16, 1] },
      );
    }
    if (/sofa|couch/i.test(p)) {
      objects.push(
        { id: 'sofa', name: 'Sofa', kind: 'cube', preset: 'fabric', color: pickColor(p, '#4f5f7f'), position: [0, 0.3, 1.4], scale: [2.4, 0.5, 0.9] },
        { id: 'sofa-back', name: 'Sofa Back', kind: 'cube', preset: 'fabric', color: pickColor(p, '#4f5f7f'), position: [0, 0.62, 1.78], scale: [2.4, 0.6, 0.2] },
      );
    }
    if (/table/i.test(p) && !/desk/i.test(p)) {
      objects.push(
        { id: 'table', name: 'Table', kind: 'cylinder', preset: 'wood', position: [1.6, 0.7, 1.2], scale: [0.9, 0.06, 0.9] },
        { id: 'table-leg', name: 'Table Leg', kind: 'cylinder', preset: 'wood', position: [1.6, 0.35, 1.2], scale: [0.1, 0.7, 0.1] },
      );
    }
    if (/plant|tree|fern/i.test(p)) {
      objects.push(
        { id: 'plant-pot', name: 'Plant Pot', kind: 'cylinder', preset: 'stone', color: '#7a6a5a', position: [width / 2 - 0.8, 0.25, -depth / 2 + 0.8], scale: [0.3, 0.5, 0.3] },
        { id: 'plant', name: 'Plant', kind: 'cone', preset: 'plastic', color: '#3f8f4f', position: [width / 2 - 0.8, 0.95, -depth / 2 + 0.8], scale: [0.5, 1.1, 0.5] },
      );
    }
    if (neon) {
      const strips = countFor(p, 'light', 2);
      for (let i = 0; i < strips; i++) {
        objects.push({
          id: `neon-${i + 1}`,
          name: `Neon Strip ${i + 1}`,
          kind: 'cube',
          preset: 'neon',
          color: neonColor,
          emissive: neonColor,
          emissiveIntensity: 2.4,
          position: [(i - (strips - 1) / 2) * (width / (strips + 1)), height - 0.35, -depth / 2 + 0.06],
          scale: [width / 3, 0.08, 0.06],
        });
      }
      objects.push({ id: 'neon-fill', name: 'Neon Fill Light', kind: 'light', position: [0, height - 0.8, 0], light: { kind: 'point', color: neonColor, intensity: 12, distance: 14 } });
      postfx = { bloom: 0.7, vignette: 0.4 };
      notes.push('bloom post-processing for the neon glow');
    }
    objects.push({ id: 'room-light', name: 'Room Light', kind: 'light', position: [1.5, height - 0.4, 1.5], light: { kind: 'point', intensity: neon ? 6 : 14, distance: 18 } });
    objects.push({ id: 'room-ambient', name: 'Ambient', kind: 'light', position: [0, 2, 0], light: { kind: 'hemisphere', intensity: neon ? 0.35 : 0.7 } });
  } else if (/solar system|planets|orbit|galaxy/i.test(p)) {
    title = 'Solar system';
    environment = 'void';
    postfx = { bloom: 0.6, vignette: 0.45 };
    objects.push(
      { id: 'sun', name: 'Sun', kind: 'sphere', preset: 'neon', color: '#ffd166', emissive: '#ff9f1c', emissiveIntensity: 2.6, scale: [1.1, 1.1, 1.1] },
      { id: 'sun-light', name: 'Sun Light', kind: 'light', light: { kind: 'point', intensity: 40, distance: 0 } },
    );
    const planets: [string, number, number, string][] = [
      ['Mercury', 2.2, 0.16, '#9c8f84'],
      ['Venus', 3.1, 0.24, '#e6b877'],
      ['Earth', 4.2, 0.26, '#3f7fd6'],
      ['Mars', 5.4, 0.2, '#c1553a'],
      ['Jupiter', 7.2, 0.5, '#d9a06b'],
    ];
    const howMany = clamp(countFor(p, 'planet', planets.length), 1, planets.length);
    for (let i = 0; i < howMany; i++) {
      const [name, radius, size, color] = planets[i];
      objects.push(
        { id: `orbit-${i}`, name: `${name} Orbit`, kind: 'torus', preset: 'matte', color: '#3b4a6b', opacity: 0.5, rotation: [90, 0, 0], scale: [radius, radius, 1] },
        { id: `planet-${i}`, name, kind: 'sphere', preset: 'stone', color, position: [radius, 0, 0], scale: [size, size, size] },
      );
    }
  } else if (/forest|trees|jungle|woods/i.test(p)) {
    title = 'Forest';
    environment = 'forest';
    fog = { color: '#8fae86', near: 12, far: 60 };
    objects.push({ id: 'ground', name: 'Ground', kind: 'plane', preset: 'matte', color: '#3c7a4b', rotation: [-90, 0, 0], scale: [30, 1, 30] });
    const trees = clamp(countFor(p, 'tree', 8), 1, 24);
    objects.push({
      id: 'tree',
      name: 'Tree',
      kind: 'cone',
      preset: 'plastic',
      color: '#2f7d4f',
      position: [4, 1.4, 0],
      scale: [1.2, 2.6, 1.2],
      repeat: { count: trees, radius: 9 },
    });
    objects.push({ id: 'sun', name: 'Sun Light', kind: 'light', position: [8, 12, 6], light: { kind: 'directional', intensity: 2 } });
    notes.push(`${trees} trees placed in a ring`);
  } else if (/city|buildings|skyline|street/i.test(p)) {
    title = 'City block';
    environment = /night/i.test(p) ? 'night' : 'overcast';
    objects.push({ id: 'ground', name: 'Ground', kind: 'plane', preset: 'stone', color: '#3a3f47', rotation: [-90, 0, 0], scale: [40, 1, 40] });
    const towers = clamp(countFor(p, 'building', 8), 3, 30);
    objects.push({
      id: 'tower',
      name: 'Building',
      kind: 'cube',
      preset: 'stone',
      color: '#6b7280',
      position: [8, 2.5, 0],
      scale: [2, 5, 2],
      repeat: { count: towers, radius: 12 },
    });
    objects.push({ id: 'sun', name: 'Sun Light', kind: 'light', position: [10, 14, 8], light: { kind: 'directional', intensity: 1.8 } });
  } else if (/stage|product|showcase|pedestal/i.test(p)) {
    title = 'Product showcase';
    environment = 'studio';
    objects.push(
      { id: 'backdrop', name: 'Backdrop', kind: 'plane', preset: 'matte', color: '#e9eef8', position: [0, 2.4, -2.5], scale: [12, 6, 1] },
      { id: 'floor', name: 'Stage', kind: 'cylinder', preset: 'plastic', color: '#f2f5fa', rotation: [-90, 0, 0], position: [0, 0.02, 0], scale: [3, 1, 3] },
      { id: 'pedestal', name: 'Pedestal', kind: 'cylinder', preset: 'plastic', color: '#dfe5ee', position: [0, 0.35, 0], scale: [1, 0.7, 1] },
      { id: 'hero', name: 'Product', kind: 'torus', preset: 'metal', color: pickColor(p, '#c3cad6'), position: [0, 1.15, 0], scale: [1.3, 1.3, 1.3] },
      { id: 'key', name: 'Key Light', kind: 'light', position: [3, 4, 3], light: { kind: 'directional', intensity: 2.2 } },
      { id: 'fill', name: 'Fill Light', kind: 'light', position: [-3, 2, 2], light: { kind: 'point', intensity: 12, distance: 20 } },
    );
  } else {
    // generic: a small arrangement around the origin
    title = 'Generated scene';
    const accent = pickColor(p, '#7c99ff');
    objects.push(
      { id: 'ground', name: 'Ground', kind: 'plane', preset: 'matte', color: '#2a2f3a', rotation: [-90, 0, 0], scale: [20, 1, 20] },
      { id: 'centerpiece', name: 'Centerpiece', kind: /sphere|ball|orb/i.test(p) ? 'sphere' : /cylinder|column|pillar/i.test(p) ? 'cylinder' : /cone|spire/i.test(p) ? 'cone' : 'cube', preset: /glass/i.test(p) ? 'glass' : /metal|chrome|steel/i.test(p) ? 'metal' : /wood/i.test(p) ? 'wood' : 'plastic', color: accent, position: [0, 0.8, 0], scale: [1.4, 1.4, 1.4] },
      { id: 'satellite', name: 'Satellite', kind: 'sphere', preset: 'metal', color: '#c3cad6', position: [2.4, 0.5, 0], scale: [0.5, 0.5, 0.5], repeat: { count: clamp(countFor(p, 'object', 3), 1, 12), radius: 2.4 } },
      { id: 'key', name: 'Key Light', kind: 'light', position: [4, 5, 3], light: { kind: 'directional', intensity: 1.9 } },
      { id: 'rim', name: 'Rim Light', kind: 'light', position: [-4, 2, -3], light: { kind: 'point', intensity: 10, distance: 18 } },
    );
    notes.push('generic composition — try “a sci-fi room with a desk and two monitors” for richer results');
  }

  return { title, objects, environment, fog, postfx, notes: notes.join(' · ') || undefined, source: 'local' };
}

// ---------------------------------------------------------------------------
// LLM layer (same schema, validated)
// ---------------------------------------------------------------------------

const LLM_SYSTEM = `You are a 3D scene planner for a browser 3D editor.
Reply with JSON ONLY, no prose, matching:
{"title":string,"objects":[{"id":string,"name":string,"kind":"cube|sphere|cylinder|cone|plane|torus|group|light","parent":string|null,"position":[x,y,z],"rotation":[degX,degY,degZ],"scale":[x,y,z],"color":"#rrggbb","preset":"plastic|metal|glass|wood|stone|fabric|neon|matte|gold|chrome|rubber|emerald","emissive":"#rrggbb","emissiveIntensity":number,"light":{"kind":"point|directional|spot|ambient|hemisphere","intensity":number,"color":"#rrggbb"},"repeat":{"count":number,"radius":number}}],"environment":"room|studio|sunset|night|overcast|cyberpunk|forest|void","notes":string}
Rules: units are metres; 1 unit ~ 1m; keep positions within ±20; a "plane" is a flat surface (rotate -90 on X to make it a floor); group related objects under a parent "group" node; include at least one light; at most 60 objects; never invent other kinds or fields.`;

const VALID_KINDS = new Set(['cube', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'group', 'light']);
const VALID_PRESETS = new Set(['plastic', 'metal', 'glass', 'wood', 'stone', 'fabric', 'neon', 'matte', 'gold', 'chrome', 'rubber', 'emerald']);
const VALID_ENVS = new Set(['room', 'studio', 'sunset', 'night', 'overcast', 'cyberpunk', 'forest', 'void']);
const VALID_LIGHTS = new Set(['point', 'directional', 'spot', 'ambient', 'hemisphere']);

/** Hard validation + clamping of an LLM-produced plan. */
export function sanitizePlan(raw: unknown, fallbackTitle = 'Generated scene'): ScenePlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.objects) ? obj.objects : null;
  if (!list || !list.length) return null;

  const seen = new Set<string>();
  const objects: PlannedObject[] = [];
  for (const item of list.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = String(o.kind ?? 'cube');
    if (!VALID_KINDS.has(kind)) continue;
    let id = String(o.id ?? uid()).slice(0, 40);
    if (seen.has(id)) id = `${id}-${objects.length}`;
    seen.add(id);
    const node: PlannedObject = {
      id,
      name: String(o.name ?? kind).slice(0, 60),
      kind: kind as PlannedObject['kind'],
    };
    if (typeof o.parent === 'string' && o.parent !== id) node.parent = o.parent;
    node.position = v(o.position as [number, number, number]).map((n) => clamp(n, -40, 40)) as [number, number, number];
    node.rotation = v(o.rotation as [number, number, number]).map((n) => clamp(n, -360, 360)) as [number, number, number];
    const scale = v(o.scale as [number, number, number], [1, 1, 1]);
    node.scale = scale.map((n) => clamp(n, 0.02, 40)) as [number, number, number];
    if (typeof o.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(o.color)) node.color = o.color;
    if (typeof o.preset === 'string' && VALID_PRESETS.has(o.preset)) node.preset = o.preset as MaterialPresetId;
    if (typeof o.emissive === 'string' && /^#[0-9a-f]{3,8}$/i.test(o.emissive)) node.emissive = o.emissive;
    if (typeof o.emissiveIntensity === 'number') node.emissiveIntensity = clamp(o.emissiveIntensity, 0, 6);
    if (o.light && typeof o.light === 'object') {
      const l = o.light as Record<string, unknown>;
      const lkind = String(l.kind ?? 'point');
      if (VALID_LIGHTS.has(lkind)) {
        node.light = {
          kind: lkind as LightKind,
          intensity: typeof l.intensity === 'number' ? clamp(l.intensity, 0, 60) : 6,
          color: typeof l.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(l.color) ? l.color : '#ffffff',
        };
      }
    }
    if (o.repeat && typeof o.repeat === 'object') {
      const r = o.repeat as Record<string, unknown>;
      const count = typeof r.count === 'number' ? clamp(Math.round(r.count), 1, 24) : 0;
      if (count > 1) {
        node.repeat = {
          count,
          radius: typeof r.radius === 'number' ? clamp(r.radius, 0.2, 40) : 3,
          axis: r.axis === 'x' || r.axis === 'z' ? r.axis : 'y',
        };
      }
    }
    objects.push(node);
  }
  if (!objects.length) return null;

  // parents must exist and must not create cycles
  const byId = new Map(objects.map((o) => [o.id, o]));
  for (const o of objects) {
    if (!o.parent || !byId.has(o.parent)) {
      o.parent = null;
      continue;
    }
    let cur: PlannedObject | undefined = byId.get(o.parent);
    let hops = 0;
    while (cur && hops++ < 64) {
      if (cur.id === o.id) {
        o.parent = null;
        break;
      }
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }

  const plan: ScenePlan = {
    title: String(obj.title ?? fallbackTitle).slice(0, 80),
    objects,
    source: 'llm',
  };
  if (typeof obj.environment === 'string' && VALID_ENVS.has(obj.environment)) {
    plan.environment = obj.environment as ScenePlan['environment'];
  }
  if (typeof obj.notes === 'string') plan.notes = obj.notes.slice(0, 400);
  return plan;
}

/** Ask the configured chat provider for a plan; falls back to the local rules. */
export async function planScene(prompt: string, opts: { preferLlm?: boolean } = {}): Promise<ScenePlan> {
  const local = planSceneLocally(prompt);
  if (opts.preferLlm === false) return local;
  try {
    const { chatSmart } = await import('./factory.js');
    const reply = await chatSmart([
      { role: 'system', content: LLM_SYSTEM },
      { role: 'user', content: `Build a scene for: ${prompt}` },
    ], { maxTokens: 2400, temperature: 0.6, signal: AbortSignal.timeout(25000) });
    const json = extractJson(reply);
    if (!json) return local;
    const plan = sanitizePlan(json, 'Generated scene');
    if (!plan) return local;
    if (!plan.objects.some((o) => o.kind === 'light')) {
      plan.objects.push({ id: 'ai-key-light', name: 'Key Light', kind: 'light', position: [4, 6, 4], light: { kind: 'directional', intensity: 1.8, color: '#ffffff' } });
    }
    return plan;
  } catch {
    return local;
  }
}

/** Pull the first JSON object out of an LLM reply (fenced or raw). */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan → concrete scene data (applied by the session)
// ---------------------------------------------------------------------------

export interface ConcreteObject {
  tempId: string;
  parentTempId: string | null;
  type: ObjectType;
  name: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: string;
  materialPatch: Record<string, unknown>;
  light: PlannedObject['light'];
}

/** Expand repeats and resolve defaults into flat, buildable object data. */
export function expandPlan(plan: ScenePlan): ConcreteObject[] {
  const out: ConcreteObject[] = [];
  const idMap = new Map<string, string>();
  let counter = 0;

  const push = (node: PlannedObject, nameSuffix = '', positionOverride?: [number, number, number], index = 0, total = 1): void => {
    const baseId = `${node.id}-${counter++}`;
    idMap.set(node.id, baseId);
    const preset = node.preset ?? 'plastic';
    const patch = { ...materialPreset(preset) } as Record<string, unknown>;
    const color = node.color ?? (patch.baseColor as string) ?? '#8b9bb4';
    patch.baseColor = color;
    if (node.emissive) {
      patch.emissive = node.emissive;
      patch.emissiveIntensity = node.emissiveIntensity ?? 1.4;
    }
    if (typeof node.opacity === 'number') {
      const opacity = clamp(node.opacity, 0.05, 1);
      patch.opacity = opacity;
      patch.transparent = opacity < 1;
    }
    const position: Vec3 = {
      x: positionOverride ? positionOverride[0] : (node.position?.[0] ?? 0),
      y: positionOverride ? positionOverride[1] : (node.position?.[1] ?? 0),
      z: positionOverride ? positionOverride[2] : (node.position?.[2] ?? 0),
    };
    out.push({
      tempId: baseId,
      parentTempId: node.parent ? idMap.get(node.parent) ?? null : null,
      type: node.kind === 'light' ? 'light' : (node.kind as ObjectType),
      name: `${node.name}${nameSuffix}`,
      position,
      rotation: {
        x: ((node.rotation?.[0] ?? 0) * Math.PI) / 180,
        y: ((node.rotation?.[1] ?? 0) * Math.PI) / 180,
        z: ((node.rotation?.[2] ?? 0) * Math.PI) / 180,
      },
      scale: {
        x: node.scale?.[0] ?? 1,
        y: node.scale?.[1] ?? 1,
        z: node.scale?.[2] ?? 1,
      },
      color,
      materialPatch: patch,
      light: node.light,
    });
    void index;
    void total;
  };

  // parents before children
  const ordered = [...plan.objects].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
  for (const node of ordered) {
    if (node.repeat && node.repeat.count > 1) {
      const count = node.repeat.count;
      const radius = node.repeat.radius ?? 3;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const base = node.position ?? [0, 0, 0];
        const pos: [number, number, number] = [
          base[0] + Math.cos(angle) * radius * 0.6 + (Math.random() - 0.5) * radius * 0.25,
          base[1],
          base[2] + Math.sin(angle) * radius * 0.6 + (Math.random() - 0.5) * radius * 0.25,
        ];
        push(node, ` ${i + 1}`, pos, i, count);
      }
      continue;
    }
    push(node);
  }
  return out;
}

export function describePlan(plan: ScenePlan): string {
  const lights = plan.objects.filter((o) => o.kind === 'light').length;
  return `${plan.objects.length} objects · ${lights} light${lights === 1 ? '' : 's'}${plan.environment ? ` · ${plan.environment} environment` : ''} · ${plan.source === 'llm' ? 'AI planned' : 'offline planner'}`;
}
