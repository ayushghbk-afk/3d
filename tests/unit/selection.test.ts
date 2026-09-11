import { describe, it, expect } from 'vitest';
import { SelectionStore } from '../../src/state/selection';
import { makeStubSession } from '../helpers/stub-session';
import { createProjectDoc, defaultObject } from '../../src/state/models';

describe('SelectionStore (multi-select, single-id back-compat)', () => {
  it('exposes the last picked object as the primary value', () => {
    const sel = new SelectionStore();
    const seen: (string | null)[] = [];
    sel.subscribe((id) => seen.push(id));

    sel.only('a');
    expect(sel.get()).toBe('a');
    sel.setIds(['a', 'b', 'c']);
    expect(sel.get()).toBe('c');
    expect(sel.all()).toEqual(['a', 'b', 'c']);
  });

  it('adds, toggles and removes without losing order', () => {
    const sel = new SelectionStore();
    sel.setIds(['a', 'b']);
    sel.add('c');
    expect(sel.ids()).toEqual(['a', 'b', 'c']);
    sel.toggle('b');
    expect(sel.ids()).toEqual(['a', 'c']);
    sel.toggle('b');
    expect(sel.ids()).toEqual(['a', 'c', 'b']);
    expect(sel.get()).toBe('b');
  });

  it('never stores duplicates', () => {
    const sel = new SelectionStore();
    sel.setIds(['a', 'a', 'b']);
    expect(sel.ids()).toEqual(['a', 'b']);
    sel.add('a');
    expect(sel.count()).toBe(2);
  });

  it('notifies both single and multi subscribers on every change', () => {
    const sel = new SelectionStore();
    let idCalls = 0;
    let listCalls = 0;
    sel.subscribe(() => idCalls++);
    sel.subscribeIds(() => listCalls++);
    expect(idCalls).toBe(1); // subscribe() seeds the current value
    expect(listCalls).toBe(1);
    sel.setIds(['a']);
    sel.add('b');
    sel.remove('a');
    sel.clear();
    expect(idCalls).toBe(5);
    expect(listCalls).toBe(5);
  });

  it('is a no-op when nothing actually changes (no store spam)', () => {
    const sel = new SelectionStore();
    let listCalls = 0;
    sel.subscribeIds(() => listCalls++);
    sel.add('a');
    sel.add('a');
    sel.remove('zzz');
    sel.clear();
    sel.clear();
    expect(listCalls).toBe(3); // seed + add('a') + clear()
  });

  it('moves the primary when it is removed, and prunes deleted ids', () => {
    const sel = new SelectionStore();
    sel.setIds(['a', 'b', 'c'], 'b');
    expect(sel.get()).toBe('b');
    sel.remove('b');
    expect(sel.get()).toBe('c'); // primary falls back to the last remaining id

    sel.prune((id) => id !== 'c'); // 'c' vanished (deleted locally or by a peer)
    expect(sel.ids()).toEqual(['a']);
    expect(sel.get()).toBe('a');

    sel.prune(() => false);
    expect(sel.ids()).toEqual([]);
    expect(sel.get()).toBeNull();
  });

  it('sessions route multi-selection through selectIds / toggleSelect', () => {
    const { session: s, doc } = makeStubSession();
    const a = defaultObject('cube', 'A');
    const b = defaultObject('cube', 'B');
    doc.objects.push(a, b);
    s.viewport.addObject(a);
    s.viewport.addObject(b);

    s.selectIds([a.id, b.id]);
    expect(s.selectedIds()).toEqual([a.id, b.id]);
    expect(s.selectedObjects()).toHaveLength(2);
    expect(s.selectedObject()?.id).toBe(b.id); // primary

    s.toggleSelect(a.id);
    expect(s.selectedIds()).toEqual([b.id]);
    s.selectAll();
    expect(s.selection.count()).toBe(2);
    s.selectInvert();
    expect(s.selection.count()).toBe(0);
  });

  it('prunes selection ids that no longer exist in the document', () => {
    const { session: s, doc } = makeStubSession(createProjectDoc('T', 'solo', 'guest'));
    const a = defaultObject('cube', 'A');
    doc.objects.push(a);
    s.select(a.id);
    doc.objects = doc.objects.filter((o) => o.id !== a.id);
    s.selection.prune((id) => doc.objects.some((o) => o.id === id));
    expect(s.selection.count()).toBe(0);
  });
});
