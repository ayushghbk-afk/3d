import * as THREE from 'three';
import type { EditorSession } from './session.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { exportGlb, docClipsToAnimationClips, exportNodeName } from '../engine/gltf.js';
import { downloadBlob, pickFiles } from '../lib/utils.js';
import { toast } from '../ui/toast.js';
import { localDb } from '../lib/indexeddb.js';
import { normalizeDoc, type ProjectDoc } from '../state/models.js';

export interface ExportOps {
  exportObj(this: EditorSession): Promise<void>;
  exportPng(this: EditorSession, width?: number, height?: number): Promise<void>;
  exportWebScene(this: EditorSession): Promise<void>;
  exportProjectBackup(this: EditorSession): Promise<void>;
  importProjectBackupFile(this: EditorSession): Promise<void>;
}

/** Build a THREE scene from the doc (mirrors the viewport layout). */
function buildExportScene(session: EditorSession): { root: THREE.Group; idToNode: Map<string, THREE.Object3D> } {
  const root = new THREE.Group();
  const nodes = new Map<string, THREE.Object3D>();
  const idToNode = new Map<string, THREE.Object3D>();
  // parents first so children can attach
  const ordered = [...session.doc.objects].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
  for (const data of ordered) {
    const obj = session.viewport.objects.get(data.id);
    if (!obj) continue;
    const clone = obj.clone(true);
    clone.name = exportNodeName(data.name, nodes.size);
    clone.position.set(data.position.x, data.position.y, data.position.z);
    clone.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z);
    clone.scale.set(data.scale.x, data.scale.y, data.scale.z);
    clone.visible = data.visible;
    nodes.set(data.id, clone);
    idToNode.set(data.id, clone);
    const parent = data.parentId ? nodes.get(data.parentId) : null;
    (parent ?? root).add(clone);
  }
  return { root, idToNode };
}

function safeName(name: string): string {
  return (name || 'scene').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scene';
}

export const exportOps: ExportOps = {
  async exportObj(): Promise<void> {
    const { root } = buildExportScene(this);
    if (!root.children.length) {
      toast('Nothing to export', 'warn');
      return;
    }
    try {
      const text = new OBJExporter().parse(root);
      downloadBlob(new Blob([text], { type: 'model/obj' }), `${safeName(this.doc.name)}.obj`);
      toast('OBJ exported', 'success');
      this.logActivity('system', 'exported OBJ');
    } catch (e) {
      toast(`OBJ export failed: ${(e as Error).message}`, 'warn');
    }
  },

  async exportPng(width = 1920, height = 1080): Promise<void> {
    const url = this.viewport.capturePng(width, height);
    if (!url) {
      toast('Render failed — try a smaller size', 'warn');
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName(this.doc.name)}-${width}x${height}.png`;
    a.click();
    toast('PNG rendered', 'success');
    this.logActivity('system', `rendered PNG (${width}×${height})`);
  },

  async exportWebScene(): Promise<void> {
    const { root, idToNode } = buildExportScene(this);
    if (!root.children.length) {
      toast('Nothing to export', 'warn');
      return;
    }
    const animations = docClipsToAnimationClips(this.doc.clips, idToNode);
    let glb: ArrayBuffer;
    try {
      glb = await exportGlb(root, animations);
    } catch (e) {
      toast(`Scene export failed: ${(e as Error).message}`, 'warn');
      return;
    }
    const bytes = new Uint8Array(glb);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    const hasAnim = animations.length > 0;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>${this.doc.name.replace(/</g, '&lt;')}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0e1117; color: #e6ebf5; font: 14px system-ui, sans-serif; }
  #app { position: fixed; inset: 0; }
  .hint { position: fixed; left: 12px; bottom: 12px; opacity: .6; font-size: 12px; }
</style>
</head>
<body>
<div id="app"></div>
<div class="hint">drag to orbit · scroll or pinch to zoom${hasAnim ? ' · animation plays automatically' : ''}</div>
<script type="module">
import * as THREE from 'https://unpkg.com/three@0.170.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.170.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://unpkg.com/three@0.170.0/examples/jsm/controls/OrbitControls.js';

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
sun.castShadow = true;
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
camera.position.set(4, 3, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const b64 = '${b64}';
const bin = atob(b64);
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

const loader = new GLTFLoader();
loader.parse(bytes.buffer, '', (gltf) => {
  const model = gltf.scene;
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    camera.position.copy(center).add(new THREE.Vector3(size * 0.6, size * 0.45, size * 0.9));
    controls.target.copy(center);
  }
  let mixer = null;
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(gltf.animations[0]).play();
  }
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (mixer) mixer.update(dt);
    controls.update();
    renderer.render(scene, camera);
  });
}, (err) => {
  document.getElementById('app').textContent = 'Could not load the scene: ' + err;
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
</body>
</html>`;
    downloadBlob(new Blob([html], { type: 'text/html' }), `${safeName(this.doc.name)}-web.html`);
    toast('Web scene exported — open the HTML anywhere', 'success');
    this.logActivity('system', 'exported a standalone web scene');
  },

  async exportProjectBackup(): Promise<void> {
    const payload = {
      format: 'web3d-studio-project',
      version: 1,
      exportedAt: new Date().toISOString(),
      project: JSON.parse(JSON.stringify(this.doc)) as ProjectDoc,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${safeName(this.doc.name)}.3dproject`);
    toast('Backup downloaded', 'success');
  },

  async importProjectBackupFile(): Promise<void> {
    const files = await pickFiles('.3dproject,application/json');
    if (!files.length) return;
    const text = await files[0].text();
    let parsed: { project?: ProjectDoc };
    try {
      parsed = JSON.parse(text) as { project?: ProjectDoc };
    } catch {
      toast('That file is not a valid backup', 'warn');
      return;
    }
    const project = parsed.project;
    if (!project || !Array.isArray(project.objects)) {
      toast('Backup is missing scene data', 'warn');
      return;
    }
    normalizeDoc(project);
    project.id = this.doc.id; // restore INTO the open project
    project.updatedAt = new Date().toISOString();
    this.history.checkpoint(this.doc, 'Import backup');
    this.doc.objects = project.objects;
    this.doc.materials = project.materials;
    this.doc.clips = project.clips;
    this.doc.scripts = project.scripts ?? [];
    this.doc.assets = project.assets ?? [];
    this.doc.settings = project.settings;
    this.doc.collections = project.collections ?? [];
    this.doc.cameraBookmarks = project.cameraBookmarks ?? [];
    await localDb.saveProject(this.doc);
    this.rebuildFromDoc();
    this.applySettings();
    this.markDirty('restore');
    toast('Backup restored', 'success');
  },
};
