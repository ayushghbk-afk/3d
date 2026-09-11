import { Store, type Unsubscribe } from './store.js';

/**
 * Multi-selection with a single-object back-compat surface.
 *
 * The editor (and the documented Agent API / script sandbox) used to treat the
 * selection as one id, so this stays a `Store<string | null>` whose value is
 * always the *primary* (last picked) object. Multi-select adds an ordered id
 * list plus `subscribeIds`, so existing `selection.get()` / `subscribe()`
 * callers keep working unchanged while the gizmo, inspector and outliner can
 * operate on the whole set.
 */
export class SelectionStore extends Store<string | null> {
  private list: string[] = [];
  private listSubs = new Set<(ids: readonly string[]) => void>();

  constructor() {
    super(null);
  }

  /** Every selected id, in pick order. */
  all(): readonly string[] {
    return this.list;
  }

  ids(): string[] {
    return [...this.list];
  }

  count(): number {
    return this.list.length;
  }

  has(id: string | null | undefined): boolean {
    return !!id && this.list.includes(id);
  }

  /** Replace the selection. `primary` defaults to the last id in the list. */
  setIds(ids: Iterable<string>, primary?: string | null): void {
    const next: string[] = [];
    for (const id of ids) {
      if (id && !next.includes(id)) next.push(id);
    }
    const p = primary ?? next[next.length - 1] ?? null;
    this.list = next;
    this.commit(p);
  }

  /** Select exactly one object (or nothing). */
  only(id: string | null): void {
    this.setIds(id ? [id] : []);
  }

  add(id: string): void {
    if (!id || this.list.includes(id)) return;
    this.list = [...this.list, id];
    this.commit(id);
  }

  remove(id: string): void {
    if (!this.list.includes(id)) return;
    this.list = this.list.filter((x) => x !== id);
    const primary = this.get();
    this.commit(primary && this.list.includes(primary) ? primary : this.list[this.list.length - 1] ?? null);
  }

  /** Shift/Ctrl-click behaviour: add when absent, drop when present. */
  toggle(id: string): void {
    if (this.list.includes(id)) this.remove(id);
    else this.add(id);
  }

  clear(): void {
    if (!this.list.length && this.get() === null) return;
    this.list = [];
    this.commit(null);
  }

  /** Drop ids that no longer exist (deleted locally or by a peer). */
  prune(exists: (id: string) => boolean): void {
    const kept = this.list.filter(exists);
    if (kept.length === this.list.length) return;
    this.list = kept;
    const primary = this.get();
    this.commit(primary && kept.includes(primary) ? primary : kept[kept.length - 1] ?? null);
  }

  /** Fires for every change to the id list (including primary changes). */
  subscribeIds(fn: (ids: readonly string[]) => void): Unsubscribe {
    this.listSubs.add(fn);
    fn(this.list);
    return () => {
      this.listSubs.delete(fn);
    };
  }

  private commit(primary: string | null): void {
    this.listSubs.forEach((fn) => fn(this.list));
    // Always notify: multi-select edits must refresh single-selection UI too.
    super.set(primary);
  }
}
