import type { ObjectPhysics } from '../state/models.js';

/**
 * Standalone web-game export.
 *
 * `exportWebScene` produces an orbit viewer; this produces the same single
 * HTML file with a ▶ Play mode on top: first-person WASD/touch controls,
 * gravity, colliders derived from the scene's physics bodies, trigger volumes
 * and the project's `play` / `frame` scripts.
 *
 * Kept in its own module (and pure) so the generated page can be unit-tested
 * without a browser: no DOM, no three.js, just template assembly.
 */

export interface ExportedCollider {
  /** Node name inside the exported GLB (see `exportNodeName`). */
  name: string;
  shape: NonNullable<ObjectPhysics['shape']>;
  dynamic: boolean;
  trigger: boolean;
  mass: number;
  restitution: number;
  /** World-space centre and half-extents at export time. */
  center: [number, number, number];
  half: [number, number, number];
  radius: number;
}

export interface ExportedScript {
  name: string;
  trigger: 'play' | 'frame';
  code: string;
}

export interface WebGameExportOptions {
  title: string;
  /** GLB bytes, base64 encoded. */
  glbBase64: string;
  colliders?: ExportedCollider[];
  scripts?: ExportedScript[];
  hasAnimation?: boolean;
  /** Player tuning, mirrored from Play Mode. */
  speed?: number;
  eyeHeight?: number;
  gravity?: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Strip `</script>` so embedded code can never break out of its tag. */
const scriptSafe = (code: string): string => code.replace(/<\/script/gi, '<\\/script');

export function buildWebGameHtml(o: WebGameExportOptions): string {
  const colliders = o.colliders ?? [];
  const scripts = (o.scripts ?? []).filter((s) => s.trigger === 'play' || s.trigger === 'frame');
  const playable = colliders.some((c) => !c.trigger) || colliders.length > 0;
  const speed = o.speed ?? 4.5;
  const eye = o.eyeHeight ?? 1.6;
  const gravity = o.gravity ?? 18;
  const data = JSON.stringify({ colliders, scripts }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>${esc(o.title)}</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0e1117; color: #e6ebf5; font: 14px system-ui, sans-serif; }
  #app { position: fixed; inset: 0; }
  canvas { display: block; }
  .hud { position: fixed; left: 12px; bottom: 12px; opacity: .65; font-size: 12px; pointer-events: none; }
  .btn { font: inherit; padding: 8px 14px; border-radius: 10px; border: 1px solid #2a3346; background: #161b26; color: #e6ebf5; }
  #playBtn { position: fixed; right: 14px; bottom: 14px; padding: 10px 18px; font-weight: 600; cursor: pointer; z-index: 5; }
  #exitBtn { position: fixed; right: 14px; top: 14px; cursor: pointer; z-index: 6; display: none; }
  #toast { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); background: #161b26cc; border: 1px solid #2a3346;
           padding: 8px 14px; border-radius: 10px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 6; }
  #toast.show { opacity: 1; }
  #pad { position: fixed; left: 16px; bottom: 16px; width: 132px; height: 132px; border-radius: 50%;
         background: #10141dbb; border: 1px solid #2a3346; display: none; touch-action: none; z-index: 6; }
  #pad i { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; background: #3b82f680; }
  #jump { position: fixed; right: 18px; bottom: 40px; width: 74px; height: 74px; border-radius: 50%; display: none; z-index: 6; }
</style>
</head>
<body>
<div id="app"></div>
<div class="hud" id="hud">drag to orbit · scroll or pinch to zoom${o.hasAnimation ? ' · animation plays automatically' : ''}</div>
<button class="btn" id="playBtn">▶ Play</button>
<button class="btn" id="exitBtn">⏹ Exit (Esc)</button>
<div id="toast"></div>
<div id="pad"><i></i></div>
<button class="btn" id="jump">Jump</button>
<script type="module">
import * as THREE from 'https://unpkg.com/three@0.170.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.170.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://unpkg.com/three@0.170.0/examples/jsm/controls/OrbitControls.js';

const DATA = ${data};
const SPEED = ${speed}, EYE = ${eye}, GRAVITY = ${gravity};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#11141b');
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1d24, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(5, 8, 4);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
camera.position.set(4, 3, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const b64 = '${o.glbBase64}';
const bin = atob(b64);
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

// ---------- tiny script runtime for exported scenes ----------
// Editor-only APIs (AI generation, project save, …) are not available here:
// scripts get a read/write handle on named objects only.
const api = {
  log: (...args) => { toast(args.join(' ')); },
  find: (name) => byName(name),
};
const byName = (name) => {
  const node = model && model.getObjectByName(name);
  if (!node) return null;
  return {
    name,
    node,
    get position() { return node.position; },
    setPosition(x, y, z) { node.position.set(x, y, z); },
    move(dx, dy, dz) { node.position.x += dx; node.position.y += dy; node.position.z += dz; },
    rotate(dx, dy, dz) { node.rotation.x += dx; node.rotation.y += dy; node.rotation.z += dz; },
    setVisible(v) { node.visible = !!v; },
  };
};
const userScripts = { play: [], frame: [] };
for (const s of (DATA.scripts || [])) {
  try {
    // eslint-disable-next-line no-new-func
    userScripts[s.trigger].push(new Function('scene', 'log', '"use strict";\\n' + s.code));
  } catch (e) { console.warn('script', s.name, e); }
}
const runScripts = (kind) => {
  for (const fn of userScripts[kind]) {
    try { fn(api, api.log); } catch (e) { console.warn(e); }
  }
};

let model = null, mixer = null;
new GLTFLoader().parse(bytes.buffer, '', (gltf) => {
  model = gltf.scene;
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    camera.position.copy(center).add(new THREE.Vector3(size * 0.6, size * 0.45, size * 0.9));
    controls.target.copy(center);
    spawn.copy(center).add(new THREE.Vector3(0, Math.max(1.2, size * 0.15), size * 0.9));
  }
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(gltf.animations[0]).play();
  }
  buildColliders();
}, (err) => {
  document.getElementById('app').textContent = 'Could not load the scene: ' + err;
});

// ---------- physics ----------
const bodies = [];
const spawn = new THREE.Vector3(0, EYE, 4);
function buildColliders() {
  bodies.length = 0;
  for (const c of (DATA.colliders || [])) {
    const node = model ? model.getObjectByName(c.name) : null;
    if (!node) continue;
    bodies.push({
      name: c.name,
      node,
      shape: c.shape,
      dynamic: !!c.dynamic,
      trigger: !!c.trigger,
      restitution: c.restitution ?? 0,
      mass: c.mass ?? 1,
      half: new THREE.Vector3(c.half[0], c.half[1], c.half[2]),
      radius: c.radius || 0,
      velocity: new THREE.Vector3(),
      entered: false,
    });
  }
}

const tmpBox = new THREE.Box3();
function worldBox(node, half) {
  tmpBox.setFromObject(node);
  if (tmpBox.isEmpty()) {
    const c = new THREE.Vector3();
    node.getWorldPosition(c);
    return new THREE.Box3(c.clone().sub(half), c.clone().add(half));
  }
  return tmpBox.clone();
}

/** Push a moving sphere out of every static box it overlaps (axis separated). */
function resolve(pos, radius) {
  for (const b of bodies) {
    if (b.dynamic || b.trigger) continue;
    const box = worldBox(b.node, b.half).expandByScalar(radius);
    if (pos.x < box.min.x || pos.x > box.max.x || pos.y < box.min.y || pos.y > box.max.y || pos.z < box.min.z || pos.z > box.max.z) continue;
    const dxMin = pos.x - box.min.x, dxMax = box.max.x - pos.x;
    const dyMin = pos.y - box.min.y, dyMax = box.max.y - pos.y;
    const dzMin = pos.z - box.min.z, dzMax = box.max.z - pos.z;
    const mx = Math.min(dxMin, dxMax), my = Math.min(dyMin, dyMax), mz = Math.min(dzMin, dzMax);
    if (my <= mx && my <= mz) { pos.y += dyMin < dyMax ? -dyMin : dyMax; if (dyMin < dyMax) grounded = true; }
    else if (mx <= mz) { pos.x += dxMin < dxMax ? -dxMin : dxMax; }
    else { pos.z += dzMin < dzMax ? -dzMin : dzMax; }
  }
}

// ---------- play mode ----------
let playing = false, grounded = false, yaw = 0, pitch = 0;
const velocity = new THREE.Vector3();
const keys = new Set();
const look = { id: null, x: 0, y: 0 };
const move = { x: 0, y: 0 };

const playBtn = document.getElementById('playBtn');
const exitBtn = document.getElementById('exitBtn');
const padEl = document.getElementById('pad');
const jumpEl = document.getElementById('jump');
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function enterPlay() {
  if (playing) return;
  playing = true;
  controls.enabled = false;
  camera.position.copy(spawn);
  camera.position.y += EYE;
  velocity.set(0, 0, 0);
  grounded = false;
  playBtn.style.display = 'none';
  exitBtn.style.display = 'block';
  document.getElementById('hud').textContent = isTouch
    ? 'drag the pad to move · drag the screen to look'
    : 'WASD to move · mouse to look · Space to jump · Esc to exit';
  if (isTouch) { padEl.style.display = 'block'; jumpEl.style.display = 'block'; }
  runScripts('play');
}

function exitPlay() {
  if (!playing) return;
  playing = false;
  controls.enabled = true;
  playBtn.style.display = 'block';
  exitBtn.style.display = 'none';
  padEl.style.display = 'none';
  jumpEl.style.display = 'none';
  document.getElementById('hud').textContent = 'drag to orbit · scroll or pinch to zoom';
}

playBtn.onclick = () => enterPlay();
exitBtn.onclick = () => exitPlay();

addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { if (playing) exitPlay(); return; }
  if (!playing) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); if (grounded) { velocity.y = 6.5; grounded = false; } }
});
addEventListener('keyup', (e) => keys.delete(e.code));

renderer.domElement.addEventListener('click', () => {
  if (playing && !isTouch) renderer.domElement.requestPointerLock?.();
});
addEventListener('mousemove', (e) => {
  if (!playing || document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch = Math.max(-1.5, Math.min(1.5, pitch));
});

// touch: left pad moves, anywhere else looks, jump button jumps
padEl.addEventListener('pointerdown', (e) => {
  move.id = e.pointerId; padEl.setPointerCapture(e.pointerId); movePad(e);
});
padEl.addEventListener('pointermove', (e) => { if (move.id === e.pointerId) movePad(e); });
padEl.addEventListener('pointerup', () => { move.id = null; move.x = 0; move.y = 0; padEl.firstElementChild.style.transform = ''; });
function movePad(e) {
  const r = padEl.getBoundingClientRect();
  move.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
  move.y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
  padEl.firstElementChild.style.transform = \`translate(\${move.x * 40}px, \${move.y * 40}px)\`;
}
jumpEl.addEventListener('click', () => { if (playing && grounded) { velocity.y = 6.5; grounded = false; } });
renderer.domElement.addEventListener('pointerdown', (e) => { if (playing && isTouch) { look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY; } });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!playing || look.id !== e.pointerId) return;
  yaw -= (e.clientX - look.x) * 0.005;
  pitch -= (e.clientY - look.y) * 0.005;
  pitch = Math.max(-1.5, Math.min(1.5, pitch));
  look.x = e.clientX; look.y = e.clientY;
});
renderer.domElement.addEventListener('pointerup', () => { look.id = null; });

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
function step(dt) {
  forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  let ix = 0, iz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iz -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  ix += move.x; iz -= move.y;
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.7 : 1;
  const want = new THREE.Vector3()
    .addScaledVector(forward, iz * SPEED * sprint)
    .addScaledVector(right, ix * SPEED * sprint);
  velocity.x += (want.x - velocity.x) * Math.min(1, dt * 12);
  velocity.z += (want.z - velocity.z) * Math.min(1, dt * 12);
  velocity.y -= GRAVITY * dt;
  camera.position.addScaledVector(velocity, dt);
  grounded = false;
  resolve(camera.position, 0.35);
  if (camera.position.y < -20) { camera.position.copy(spawn); velocity.set(0, 0, 0); }
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  // dynamic bodies: gravity + rest on static geometry
  for (const b of bodies) {
    if (!b.dynamic || b.trigger) continue;
    const box = worldBox(b.node, b.half);
    b.velocity.y -= GRAVITY * dt;
    const center = box.getCenter(new THREE.Vector3());
    const next = center.clone().addScaledVector(b.velocity, dt);
    resolve(next, Math.max(b.radius, 0.05));
    const delta = next.clone().sub(center);
    if (Math.abs(delta.y) < 1e-6 && Math.abs(b.velocity.y) > 0.2) b.velocity.y = -b.velocity.y * b.restitution;
    if (Math.abs(delta.y) < 1e-6) b.velocity.y = 0;
    b.node.position.add(delta);
  }

  // trigger volumes
  for (const b of bodies) {
    if (!b.trigger) continue;
    const box = worldBox(b.node, b.half).expandByScalar(0.35);
    const inside = camera.position.x >= box.min.x && camera.position.x <= box.max.x
      && camera.position.y >= box.min.y && camera.position.y <= box.max.y
      && camera.position.z >= box.min.z && camera.position.z <= box.max.z;
    if (inside && !b.entered) {
      b.entered = true;
      toast('Entered ' + b.name);
      if (window.W3D && typeof window.W3D.onTrigger === 'function') window.W3D.onTrigger(b.name, true);
    } else if (!inside && b.entered) {
      b.entered = false;
      if (window.W3D && typeof window.W3D.onTrigger === 'function') window.W3D.onTrigger(b.name, false);
    }
  }
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  if (mixer) mixer.update(dt);
  if (playing) { step(dt); runScripts('frame'); }
  else controls.update();
  renderer.render(scene, camera);
});

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
</script>
${scripts.length ? `<!-- ${scripts.length} project script(s) run in play mode with a small object API -->` : ''}
</body>
</html>`;
}

/** Collider payload for one scene object, or null when physics is off. */
export function colliderFor(
  name: string,
  physics: ObjectPhysics | null | undefined,
  box: { center: [number, number, number]; half: [number, number, number] },
): ExportedCollider | null {
  if (!physics || !physics.enabled) return null;
  return {
    name,
    shape: physics.shape,
    dynamic: !!physics.dynamic,
    trigger: !!physics.trigger,
    mass: physics.mass,
    restitution: physics.restitution,
    center: box.center,
    half: box.half,
    radius: Math.max(box.half[0], box.half[1], box.half[2]),
  };
}
