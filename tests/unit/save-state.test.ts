import { expect, it, vi } from 'vitest';
import { EditorSession } from '../../src/editor/session';
import { Store } from '../../src/state/store';
import { createProjectDoc } from '../../src/state/models';

it('invalidates Saved immediately, before either debounced save starts', () => {
  // Exercise the coordinator mutation path without constructing a GPU viewport.
  const session = Object.assign(Object.create(EditorSession.prototype), {
    doc: createProjectDoc('Test', 'solo', 'guest'),
    saveState: new Store('saved'), rev: new Store(0),
    scheduleLocal: vi.fn(), scheduleCloud: vi.fn(),
  });
  const version = session.doc.version;
  session.markDirty('transform');
  expect(session.saveState.get()).toBe('saving');
  expect(session.doc.version).toBe(version + 1);
  expect(session.scheduleLocal).toHaveBeenCalledOnce();
  expect(session.scheduleCloud).toHaveBeenCalledOnce();
});
