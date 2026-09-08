import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { localDb } from '../../src/lib/indexeddb';
import { createProjectDoc } from '../../src/state/models';

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('persists a project before acknowledging the save', async () => {
  const doc = createProjectDoc('Durable', 'solo', 'guest');
  await localDb.saveProject(doc);
  expect(await localDb.getProject(doc.id)).toEqual(doc);
});

it('rejects a transaction aborted after put request success and retains the previous document', async () => {
  const doc = createProjectDoc('Original', 'solo', 'guest');
  await localDb.saveProject(doc);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = put.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
  await expect(localDb.saveProject({ ...doc, name: 'Not committed' })).rejects.toMatchObject({ name: 'AbortError' });
  expect((await localDb.getProject(doc.id))?.name).toBe('Original');
});

it('rejects aborted queue acknowledgement and retains the operation', async () => {
  const op = { id: 'push:test', projectId: 'test', kind: 'push', payload: {}, createdAt: '', attempts: 0 };
  await localDb.enqueue(op);
  const del = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    const request = del.call(this, key);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
  await expect(localDb.clearQueue([op.id])).rejects.toMatchObject({ name: 'AbortError' });
  expect(await localDb.listQueue('test')).toEqual([op]);
});
