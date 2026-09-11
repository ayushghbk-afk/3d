import * as THREE from 'three';
import type { EditorSession } from './session.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { exportGlb, docClipsToAnimationClips, exportNodeName } from '../engine/gltf.js';
import { downloadBlob, pickFiles } from '../lib/utils.js';
import { toast } from '../ui/toast.js';
import { localDb } from '../lib/indexeddb.js';
import { normalizeDoc, type ProjectDoc } from '../state/models.js';
import { buildWebGameHtml, colliderFor, type ExportedCollider, type ExportedScript } from './web-game-export.js';

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

/** Physics bodies for the playable web export, named like the GLB nodes. */
function collectColliders(session: EditorSession, nameOf: (id: string) => string): ExportedCollider[] {
  const out: ExportedCollider[] = [];
  const box = new THREE.Box3();
  for (const data of session.doc.objects) {
    const node = session.viewport.objects.get(data.id);
    if (!node || !data.physics?.enabled) continue;
    box.setFromObject(node);
    if (box.isEmpty()) {
      const p = new THREE.Vector3();
      node.getWorldPosition(p);
      box.setFromCenterAndSize(p, new THREE.Vector3(1, 1, 1));
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const collider = colliderFor(
      nameOf(data.id),
      data.physics,
      {
        center: [center.x, center.y, center.z],
        half: [Math.max(0.02, size.x / 2), Math.max(0.02, size.y / 2), Math.max(0.02, size.z / 2)],
      },
    );
    if (collider) out.push(collider);
  }
  return out;
}

/** Scripts that make sense outside the editor: play + frame triggers only. */
function collectScripts(session: EditorSession): ExportedScript[] {
  return (session.doc.scripts ?? [])
    .filter((sc) => sc.enabled && (sc.trigger === 'play' || sc.trigger === 'frame'))
    .map((sc) => ({ name: sc.name, trigger: sc.trigger as 'play' | 'frame', code: sc.code }));
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
    // node names must match what collectColliders() reports
    const nameOf = (id: string): string => {
      const node = idToNode.get(id);
      return node?.name ?? '';
    };
    const colliders = collectColliders(this, nameOf);
    const scripts = collectScripts(this);
    const html = buildWebGameHtml({
      title: this.doc.name,
      glbBase64: btoa(binary),
      colliders,
      scripts,
      hasAnimation: animations.length > 0,
    });
    downloadBlob(new Blob([html], { type: 'text/html' }), `${safeName(this.doc.name)}-web.html`);
    toast(
      colliders.length
        ? `Web game exported — ${colliders.length} collider${colliders.length === 1 ? '' : 's'}, press ▶ Play`
        : 'Web scene exported — open the HTML anywhere',
      'success',
    );
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
