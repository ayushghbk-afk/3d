// Local-first persistence: projects, asset blobs, pending sync queue, settings.
import type { ProjectDoc } from '../state/models.js';

const DB_NAME = 'web3dstudio';
const DB_VERSION = 1;

export interface QueuedOp {
  id: string;
  projectId: string;
  kind: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('queue')) {
        const q = db.createObjectStore('queue', { keyPath: 'id' });
        q.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    // Request success is not a durable acknowledgement: the transaction can
    // still abort (quota, another request, or an explicit abort).
    t.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    t.onabort = () => {
      db.close();
      reject(t.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export const localDb = {
  async saveProject(doc: ProjectDoc): Promise<void> {
    await tx('projects', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(doc))));
  },
  async getProject(id: string): Promise<ProjectDoc | null> {
    const r = await tx<ProjectDoc | undefined>('projects', 'readonly', (s) => s.get(id));
    return r ?? null;
  },
  async listProjects(): Promise<ProjectDoc[]> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out: ProjectDoc[] = [];
      const t = db.transaction('projects', 'readonly');
      const cursor = t.objectStore('projects').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          out.push(c.value as ProjectDoc);
          c.continue();
        } else {
          db.close();
          resolve(out);
        }
      };
      cursor.onerror = () => {
        db.close();
        reject(cursor.error);
      };
    });
  },
  async deleteProject(id: string): Promise<void> {
    await tx('projects', 'readwrite', (s) => s.delete(id));
  },
  async saveBlob(id: string, blob: Blob): Promise<void> {
    await tx('blobs', 'readwrite', (s) => s.put({ id, blob }));
  },
  async getBlob(id: string): Promise<Blob | null> {
    const r = await tx<{ id: string; blob: Blob } | undefined>('blobs', 'readonly', (s) => s.get(id));
    return r?.blob ?? null;
  },
  async deleteBlob(id: string): Promise<void> {
    await tx('blobs', 'readwrite', (s) => s.delete(id));
  },
  async enqueue(op: QueuedOp): Promise<void> {
    await tx('queue', 'readwrite', (s) => s.put(op));
  },
  async listQueue(projectId?: string): Promise<QueuedOp[]> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('queue', 'readonly');
      const store = t.objectStore('queue');
      const req = projectId ? store.index('projectId').getAll(projectId) : store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve(req.result as QueuedOp[]);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  },
  async clearQueue(ids: string[]): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('queue', 'readwrite');
      const store = t.objectStore('queue');
      ids.forEach((id) => store.delete(id));
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onabort = () => {
        db.close();
        reject(t.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
      };
      t.onerror = () => {
        db.close();
        reject(t.error);
      };
    });
  },
  async getSetting(key: string): Promise<string | null> {
    const r = await tx<{ key: string; value: string } | undefined>('settings', 'readonly', (s) => s.get(key));
    return r?.value ?? null;
  },
  async setSetting(key: string, value: string): Promise<void> {
    await tx('settings', 'readwrite', (s) => s.put({ key, value }));
  },
};
