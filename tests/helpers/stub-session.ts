// @vitest-environment jsdom
/**
 * Shared headless EditorSession fixture.
 *
 * Real prototype methods, stubbed renderer/Supabase: no WebGL, no network.
 * Keeps the growing set of session stores in one place so new UI state slices
 * don't silently break every existing mutation test.
 */
import { vi } from 'vitest';
import * as THREE from 'three';
import { EditorSession } from '../../src/editor/session';
import { History } from '../../src/editor/history';
import { Store } from '../../src/state/store';
import { SelectionStore } from '../../src/state/selection';
import { createProjectDoc, defaultSnap, type ProjectDoc, type SceneObjectData } from '../../src/state/models';

export interface StubViewport {
  scene: THREE.Group;
  objects: Map<string, THREE.Object3D>;
  outline: ReturnType<typeof vi.fn>;
  outlineSet: ReturnType<typeof vi.fn>;
  captureThumbnail: () => null;
  syncMaterials: () => void;
  fixParenting: () => void;
  addObject: (d: SceneObjectData) => THREE.Object3D;
  updateObject: (d: SceneObjectData) => void;
  removeObject: (id: string) => void;
  clearAll: () => void;
  getCameraState: () => { type: 'perspective'; position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; fov: number };
  setCameraState: () => void;
  focusIds: ReturnType<typeof vi.fn>;
  setGridSize: () => void;
  raycastPointer: () => null;
  screenPositionOf: () => null;
  controls: { enabled: boolean };
  events: Record<string, unknown>;
}

export function makeStubViewport(): { viewport: StubViewport; objects: Map<string, THREE.Object3D> } {
  const objects = new Map<string, THREE.Object3D>();
  const scene = new THREE.Group();
  const viewport = {
    scene,
    objects,
    outline: vi.fn(),
    outlineSet: vi.fn(),
    captureThumbnail: () => null,
    syncMaterials: () => undefined,
    fixParenting: () => undefined,
    setGridSize: () => undefined,
    raycastPointer: () => null,
    screenPositionOf: () => null,
    controls: { enabled: true },
    events: {},
    addObject: (d: SceneObjectData) => {
      let o = objects.get(d.id);
      if (!o) {
        o = new THREE.Group();
        // a unit box mesh so bounding-box based ops (drop to ground, align,
        // mirror, framing) behave like the real viewport
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        mesh.name = 'stub-geometry';
        o.add(mesh);
        objects.set(d.id, o);
      }
      // mirror Viewport.applyTransform so world/parenting math is realistic
      o.position.set(d.position.x, d.position.y, d.position.z);
      o.rotation.set(d.rotation.x, d.rotation.y, d.rotation.z);
      o.scale.set(d.scale.x, d.scale.y, d.scale.z);
      o.userData.objectId = d.id;
      o.parent?.remove(o);
      const parent = d.parentId ? objects.get(d.parentId) : null;
      (parent ?? scene).add(o);
      return o;
    },
    updateObject: (d: SceneObjectData) => viewport.addObject(d),
    removeObject: (id: string) => {
      const o = objects.get(id);
      o?.parent?.remove(o);
      objects.delete(id);
    },
    clearAll: () => {
      for (const id of [...objects.keys()]) viewport.removeObject(id);
    },
    getCameraState: () => ({ type: 'perspective', position: { x: 4, y: 3, z: 6 }, target: { x: 0, y: 0, z: 0 }, fov: 50 }),
    setCameraState: () => undefined,
    focusIds: vi.fn(),
  } as unknown as StubViewport;
  return { viewport, objects };
}

export function makeStubSession(doc: ProjectDoc = createProjectDoc('T', 'solo', 'guest')) {
  const { viewport, objects } = makeStubViewport();
  const gizmo = { attach: vi.fn(), setMode: vi.fn(), setSnap: vi.fn(), setSpace: vi.fn(), setCamera: vi.fn(), isDragging: false, controls: { dragging: false } };
  const rig = {
    gizmo,
    sync: vi.fn(),
    setSpace: vi.fn(),
    setPivotMode: vi.fn(),
    setPivotEditing: vi.fn(),
    frameOrigin: () => new THREE.Vector3(),
    dispose: vi.fn(),
  };
  const session = Object.assign(Object.create(EditorSession.prototype), {
    doc,
    viewport: viewport as unknown as EditorSession['viewport'],
    history: new History(),
    rig,
    gizmo,
    selection: new SelectionStore(),
    transformMode: new Store('translate'),
    gizmoSpace: new Store('world'),
    pivotMode: new Store('origin'),
    transformTarget: new Store('object'),
    snapSettings: new Store(defaultSnap()),
    shadingMode: new Store('material'),
    cameraType: new Store('perspective'),
    canEdit: new Store(true),
    locks: new Store(new Map<string, unknown>()),
    peerEdits: new Store(0),
    saveState: new Store('local'),
    syncError: new Store(null),
    online: new Store(true),
    peers: new Store([]),
    peerSelections: new Store(new Map()),
    peerCursors: new Store(new Map()),
    rev: new Store(0),
    snap: new Store(false),
    loop: new Store(true),
    autoKey: new Store(false),
    anim: new Store({ playing: false, frame: 0, length: 90, fps: 30 }),
    playback: { frame: 0, playing: false, loop: true, setFrame: vi.fn(), play: vi.fn(), pause: vi.fn(), stop: vi.fn() },
    scheduleLocal: vi.fn(),
    scheduleCloud: vi.fn(),
    markDirty: vi.fn(),
    broadcastTransform: vi.fn(),
    broadcastLock: vi.fn(),
    logActivity: vi.fn(),
    pushActivity: vi.fn(),
    scriptEngine: { invalidate: vi.fn(), tick: vi.fn(), run: vi.fn(), runTrigger: vi.fn() },
    lastThumb: Date.now(),
    userId: 'guest',
    userName: 'Guest',
    disposed: false,
    blobs: new Map<string, ArrayBuffer>(),
    textures: new Map<string, THREE.Texture>(),
    sync: {
      broadcastOp: vi.fn().mockResolvedValue(undefined),
      broadcastLock: vi.fn(),
      broadcastMaterial: vi.fn(),
      broadcastSelection: vi.fn(),
      broadcastCursor: vi.fn(),
      broadcastActivity: vi.fn(),
      presenceEditing: vi.fn(),
      pushDoc: vi.fn().mockResolvedValue(true),
      start: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
  }) as unknown as EditorSession;
  return { session, doc, viewport: viewport as unknown as StubViewport, objects, gizmo, rig };
}
