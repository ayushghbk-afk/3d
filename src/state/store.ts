// Tiny typed pub/sub stores. Separate concerns per spec §44:
// editor / ui / network / project / collaboration / selection / animation.

export type Unsubscribe = () => void;

export class Store<T> {
  private value: T;
  private subs = new Set<(v: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(v: T): void {
    this.value = v;
    this.subs.forEach((s) => s(v));
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.value));
  }

  subscribe(fn: (v: T) => void): Unsubscribe {
    this.subs.add(fn);
    fn(this.value);
    return () => {
      this.subs.delete(fn);
    };
  }
}
