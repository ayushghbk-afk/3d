// GitHub = AI/code/export layer (§37-43). Real API integration, no fake lists.
// Auth: OAuth Device Flow (no backend) or PAT in sessionStorage only.

import { createProjectDoc, defaultMaterial, type ProjectDoc } from '../state/models.js';
import { fromSceneJson, toAiContext, toAssetsJson, toProjectJson, toReadme, toSceneJson } from '../editor/serialization.js';
import { uid } from '../lib/utils.js';

const TOKEN_KEY = 'w3ds.gh.token';
const API = 'https://api.github.com';

export interface GhRepo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

export interface GhBranch {
  name: string;
  sha: string;
}

export interface GhTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface DetectedProject {
  kind: 'studio' | 'assets' | 'none';
  basePath: string; // '' = repo root
  projectJson?: string;
  sceneJson?: string;
  models: GhTreeItem[];
  textures: GhTreeItem[];
  others: GhTreeItem[];
}

export function ghToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setGhToken(t: string | null): void {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
}
export function ghConnected(): boolean {
  return !!ghToken();
}

async function api(path: string, init?: RequestInit, raw = false): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...((init?.headers ?? {}) as Record<string, string>),
  };
  const t = ghToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (res.status === 401) {
    setGhToken(null);
    throw new Error('GitHub token expired — please reconnect');
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub rate limit reached — try again later');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  return res;
}

// ---------- auth ----------
export interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

export async function startDeviceFlow(clientId: string): Promise<DeviceFlow> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'repo' }),
  });
  if (!res.ok) throw new Error('Device flow failed — check the OAuth client id, or use a token instead');
  const j = (await res.json()) as {
    device_code: string; user_code: string; verification_uri: string; interval: number; error?: string; error_description?: string;
  };
  if (j.error) throw new Error(j.error_description || j.error);
  return { deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri, interval: Math.max(5, j.interval ?? 5) };
}

export async function pollDeviceToken(clientId: string, deviceCode: string): Promise<string | null> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token?: string; error?: string };
  if (j.error) {
    if (j.error === 'authorization_pending' || j.error === 'slow_down') return null;
    throw new Error(`GitHub auth failed: ${j.error}`);
  }
  return j.access_token ?? null;
}

export async function ghViewer(): Promise<{ login: string; avatar: string } | null> {
  if (!ghToken()) return null;
  try {
    const res = await api('/user');
    const j = (await res.json()) as { login: string; avatar_url: string };
    return { login: j.login, avatar: j.avatar_url };
  } catch {
    return null;
  }
}

// ---------- browse ----------
export async function listRepos(query: string): Promise<GhRepo[]> {
  const map = (r: Record<string, unknown>): GhRepo => ({
    id: r.id as number, fullName: r.full_name as string, name: r.name as string,
    owner: ((r.owner ?? {}) as { login: string }).login,
    defaultBranch: (r.default_branch as string) ?? 'main',
    private: Boolean(r.private), updatedAt: (r.updated_at as string) ?? '',
  });
  if (query.trim()) {
    const res = await api(`/search/repositories?q=${encodeURIComponent(query)}&per_page=30`);
    const j = (await res.json()) as { items: Record<string, unknown>[] };
    return (j.items ?? []).map(map);
  }
  const res = await api('/user/repos?per_page=100&sort=updated');
  return ((await res.json()) as Record<string, unknown>[]).map(map);
}

export async function listBranches(owner: string, repo: string): Promise<GhBranch[]> {
  const res = await api(`/repos/${owner}/${repo}/branches?per_page=100`);
  const j = (await res.json()) as { name: string; commit: { sha: string } }[];
  return j.map((b) => ({ name: b.name, sha: b.commit.sha }));
}

export async function getTree(owner: string, repo: string, sha: string): Promise<GhTreeItem[]> {
  const res = await api(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  const j = (await res.json()) as { tree: { path: string; type: string; sha: string; size?: number }[]; truncated?: boolean };
  if (j.truncated) throw new Error('Repository is too large to browse — narrow it down first');
  return (j.tree ?? []).filter((t) => t.type === 'blob').map((t) => ({ path: t.path, type: 'blob', sha: t.sha, size: t.size }));
}

export async function downloadFile(owner: string, repo: string, branch: string, path: string): Promise<ArrayBuffer> {
  const res = await api(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, undefined, true);
  return await res.arrayBuffer();
}

export async function downloadText(owner: string, repo: string, branch: string, path: string): Promise<string> {
  const buf = await downloadFile(owner, repo, branch, path);
  return new TextDecoder().decode(buf);
}

// ---------- detection (§39) ----------
const MODEL_EXT = ['.glb', '.gltf', '.obj'];
const TEX_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.basis'];

export function detectProject(tree: GhTreeItem[]): DetectedProject {
  const byPath = new Map(tree.map((t) => [t.path, t]));
  // studio project at root or nested dir
  const roots = new Set(['']);
  for (const t of tree) {
    const dir = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '';
    if (dir.split('/').length <= 2) roots.add(dir);
  }
  for (const base of roots) {
    const pj = base ? `${base}/project.json` : 'project.json';
    const sj = base ? `${base}/scene.json` : 'scene.json';
    if (byPath.has(pj) || byPath.has(sj)) {
      return {
        kind: 'studio', basePath: base,
        projectJson: byPath.has(pj) ? pj : undefined,
        sceneJson: byPath.has(sj) ? sj : undefined,
        models: tree.filter((t) => MODEL_EXT.some((e) => t.path.toLowerCase().endsWith(e))),
        textures: tree.filter((t) => TEX_EXT.some((e) => t.path.toLowerCase().endsWith(e))),
        others: [],
      };
    }
  }
  const models = tree.filter((t) => MODEL_EXT.some((e) => t.path.toLowerCase().endsWith(e))).slice(0, 100);
  const textures = tree.filter((t) => TEX_EXT.some((e) => t.path.toLowerCase().endsWith(e))).slice(0, 200);
  return {
    kind: models.length || textures.length ? 'assets' : 'none', basePath: '',
    models, textures, others: [],
  };
}

// ---------- import ----------
export async function importStudioProject(
  owner: string, repo: string, branch: string, det: DetectedProject, ownerId: string,
): Promise<{ doc: ProjectDoc; blobs: Map<string, ArrayBuffer>; missing: string[] }> {
  const missing: string[] = [];
  const blobs = new Map<string, ArrayBuffer>();
  let name = repo;
  if (det.projectJson) {
    try {
      const pj = JSON.parse(await downloadText(owner, repo, branch, det.projectJson)) as { name?: string };
      if (pj.name) name = pj.name;
    } catch { /* ignore */ }
  }
  const doc = createProjectDoc(name, 'solo', ownerId);
  doc.materials = [defaultMaterial('Default')];
  if (det.sceneJson) {
    const sj = JSON.parse(await downloadText(owner, repo, branch, det.sceneJson)) as Record<string, unknown>;
    const frag = fromSceneJson(sj);
    if (frag) {
      doc.objects = frag.objects;
      if (frag.materials.length) doc.materials = frag.materials;
      if (frag.clips.length) {
        doc.clips = frag.clips;
        doc.activeClipId = frag.clips[0].id;
      }
      if (frag.settings) doc.settings = frag.settings;
      if (frag.scripts?.length) doc.scripts = frag.scripts.map((s) => ({ ...s, enabled: false }));
    }
  }
  // fetch referenced model blobs (match by filename)
  for (const m of det.models.slice(0, 25)) {
    try {
      const buf = await downloadFile(owner, repo, branch, m.path);
      blobs.set(m.path, buf);
    } catch {
      missing.push(m.path);
    }
  }
  // attach blobs to imported objects by filename match
  for (const o of doc.objects) {
    if (o.type !== 'imported') continue;
    const assetName = doc.assets.find((a) => a.id === o.assetId)?.name;
    const hit = [...blobs.keys()].find((p) => (assetName && p.endsWith(assetName)) || p.toLowerCase().includes(o.name.toLowerCase().replace(/\s+/g, '-')));
    if (hit) {
      const assetId = uid();
      const buf = blobs.get(hit) as ArrayBuffer;
      doc.assets.push({
        id: assetId, name: hit.split('/').pop() ?? 'model.glb', kind: 'model',
        mime: 'model/gltf-binary', size: buf.byteLength, storagePath: null, local: true, thumb: null, createdAt: new Date().toISOString(),
      });
      blobs.set(`asset:${assetId}`, buf);
      o.assetId = assetId;
    } else {
      missing.push(`asset for "${o.name}"`);
    }
  }
  return { doc, blobs, missing };
}

export async function importLooseAssets(
  owner: string, repo: string, branch: string, items: GhTreeItem[],
): Promise<{ name: string; buf: ArrayBuffer }[]> {
  const out: { name: string; buf: ArrayBuffer }[] = [];
  for (const item of items.slice(0, 25)) {
    const buf = await downloadFile(owner, repo, branch, item.path);
    out.push({ name: item.path.split('/').pop() ?? item.path, buf });
  }
  return out;
}

// ---------- export (§40) ----------
function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function strToB64(s: string): string {
  return b64encode(new TextEncoder().encode(s).buffer as ArrayBuffer);
}

export interface ExportPlan {
  createRepo: boolean;
  repoName: string;
  branch: string;
  message: string;
}

export async function ensureRepo(repoName: string, create: boolean): Promise<{ owner: string; repo: string }> {
  const me = await ghViewer();
  if (!me) throw new Error('Not connected to GitHub');
  if (!create) {
    // repoName may be "owner/repo" or just "repo" (owned by me)
    if (repoName.includes('/')) {
      const [owner, repo] = repoName.split('/');
      return { owner, repo };
    }
    return { owner: me.login, repo: repoName };
  }
  const res = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({ name: repoName, private: false, description: `Exported from Web 3D Studio` }),
  });
  const j = (await res.json()) as { full_name: string };
  const [owner, repo] = (j.full_name as string).split('/');
  return { owner, repo };
}

export async function commitExport(
  owner: string, repo: string, plan: ExportPlan, doc: ProjectDoc,
  assetBytes: Map<string, ArrayBuffer>,
  onProgress?: (msg: string) => void,
): Promise<string> {
  // 1. resolve base commit
  let baseSha: string | null = null;
  let baseTree: string | null = null;
  try {
    const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(plan.branch)}`);
    const j = (await ref.json()) as { object: { sha: string } };
    baseSha = j.object.sha;
    const commit = (await (await api(`/repos/${owner}/${repo}/git/commits/${baseSha}`)).json()) as { tree: { sha: string } };
    baseTree = commit.tree.sha;
  } catch {
    baseSha = null; // new branch / empty repo
  }

  // 2. build blobs
  const files: { path: string; content: string; binary: boolean }[] = [
    { path: 'project.json', content: strToB64(JSON.stringify(toProjectJson(doc), null, 2)), binary: false },
    { path: 'scene.json', content: strToB64(JSON.stringify(toSceneJson(doc), null, 2)), binary: false },
    { path: 'assets.json', content: strToB64(JSON.stringify(toAssetsJson(doc), null, 2)), binary: false },
    { path: 'AI_PROJECT_CONTEXT.md', content: strToB64(toAiContext(doc)), binary: false },
    { path: 'README.md', content: strToB64(toReadme(doc)), binary: false },
  ];
  for (const a of doc.assets) {
    const buf = assetBytes.get(a.id);
    if (!buf) continue;
    const dir = a.kind === 'texture' ? 'assets/textures' : 'assets/models';
    files.push({ path: `${dir}/${a.name}`, content: b64encode(buf), binary: true });
  }
  onProgress?.(`Uploading ${files.length} files…`);

  const entries: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const f of files) {
    onProgress?.(f.path);
    const blobRes = await api(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: f.content, encoding: 'base64' }),
    });
    const bj = (await blobRes.json()) as { sha: string };
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: bj.sha });
  }

  // 3. tree + commit + ref
  const treeRes = await api(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  });
  const tree = (await treeRes.json()) as { sha: string };
  const commitRes = await api(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: plan.message, tree: tree.sha, parents: baseSha ? [baseSha] : [] }),
  });
  const commit = (await commitRes.json()) as { sha: string };
  if (baseSha) {
    await api(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(plan.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });
  } else {
    await api(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${plan.branch}`, sha: commit.sha }),
    });
  }
  return `https://github.com/${owner}/${repo}/commit/${commit.sha}`;
}
