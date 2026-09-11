import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';

/**
 * Mesh operations that work on primitive (and imported) geometry.
 *
 * Deliberately small and dependency-free — no CSG/BVH download — so the app
 * stays lightweight. Extrude/inset/loop-cut/booleans need a half-edge mesh
 * representation and are intentionally not faked here.
 */

const KEEP_ATTRIBUTES = ['position', 'normal', 'uv'];

/** Normalise a geometry so a set of them can be merged or tessellated. */
export function prepareGeometry(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): THREE.BufferGeometry {
  const g = (geo.index ? geo.toNonIndexed() : geo.clone());
  if (matrix) g.applyMatrix4(matrix);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    const count = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  // drop attributes mergeGeometries would reject (tangents, colors…) — the
  // material doesn't need them and mismatched sets fail the merge.
  for (const name of Object.keys(g.attributes)) {
    if (!KEEP_ATTRIBUTES.includes(name)) g.deleteAttribute(name);
  }
  return g;
}

/** Every mesh geometry under `root`, transformed into `root`'s local space. */
export function collectGeometries(root: THREE.Object3D): THREE.BufferGeometry[] {
  root.updateWorldMatrix(true, true);
  const inv = root.matrixWorld.clone().invert();
  const out: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    out.push(prepareGeometry(mesh.geometry, m));
  });
  return out;
}

/** Merge any number of objects into one geometry (world space, minus `origin`). */
export function mergeObjects(roots: THREE.Object3D[], origin = new THREE.Vector3()): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  const shift = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const local = new THREE.Matrix4().multiplyMatrices(shift, mesh.matrixWorld);
      geos.push(prepareGeometry(mesh.geometry, local));
    });
  }
  if (!geos.length) return null;
  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (!merged) return null;
  merged.computeVertexNormals();
  return merged;
}

/** Subdivision-ish: split long edges until they are shorter than maxEdgeLength. */
export function subdivideGeometry(geo: THREE.BufferGeometry, iterations = 2, maxEdgeLength = 0.35): THREE.BufferGeometry {
  let g = prepareGeometry(geo);
  for (let i = 0; i < Math.max(1, iterations); i++) {
    const mod = new TessellateModifier(Math.max(0.02, maxEdgeLength / (i + 1)), 6);
    g = mod.modify(g);
  }
  g.computeVertexNormals();
  return g;
}

/** Decimate a geometry to roughly `ratio` of its triangles. */
export function simplifyGeometry(geo: THREE.BufferGeometry, ratio = 0.5): THREE.BufferGeometry {
  const g = prepareGeometry(geo);
  const count = g.getAttribute('position').count;
  const target = Math.max(3, Math.floor(count * (1 - Math.min(0.95, Math.max(0.05, ratio)))));
  try {
    const out = new SimplifyModifier().modify(g, target - count > 0 ? 0 : count - target);
    out.computeVertexNormals();
    return out;
  } catch {
    return g;
  }
}

/** Stats for the inspector: triangles / vertices of an object. */
export function geometryStats(root: THREE.Object3D): { tris: number; verts: number } {
  let tris = 0;
  let verts = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry;
    verts += g.getAttribute('position')?.count ?? 0;
    tris += g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
  });
  return { tris: Math.round(tris), verts };
}

/** Apply a geometry to a viewport object (replacing whatever it had). */
export function replaceMeshGeometry(obj: THREE.Object3D, geo: THREE.BufferGeometry): boolean {
  const mesh = ((): THREE.Mesh | null => {
    if ((obj as THREE.Mesh).isMesh) return obj as THREE.Mesh;
    let found: THREE.Mesh | null = null;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!found && m.isMesh) found = m;
    });
    return found;
  })();
  if (!mesh) return false;
  mesh.geometry?.dispose();
  mesh.geometry = geo;
  return true;
}
