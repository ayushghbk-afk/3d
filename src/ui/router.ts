export type Route =
  | { name: 'dashboard' }
  | { name: 'login' }
  | { name: 'editor'; projectId: string }
  | { name: 'join'; projectId: string; code: string };

export function parseRoute(): Route {
  const h = window.location.hash || '#/';
  if (h.startsWith('#/p/')) {
    return { name: 'editor', projectId: decodeURIComponent(h.slice(4).split('?')[0]) };
  }
  if (h.startsWith('#/login')) return { name: 'login' };
  if (h.startsWith('#/join/')) {
    const rest = h.slice(7);
    const [id, query] = rest.split('?');
    const code = new URLSearchParams(query ?? '').get('code') ?? '';
    return { name: 'join', projectId: decodeURIComponent(id), code };
  }
  return { name: 'dashboard' };
}

export function nav(hash: string): void {
  window.location.hash = hash;
}

export type ViewDisposer = () => void;

export class Router {
  private dispose: ViewDisposer | null = null;

  constructor(private mount: (r: Route) => ViewDisposer | Promise<ViewDisposer>) {}

  start(): void {
    window.addEventListener('hashchange', () => void this.render());
    void this.render();
  }

  async render(): Promise<void> {
    try {
      this.dispose?.();
    } catch {
      /* ignore */
    }
    this.dispose = null;
    document.getElementById('modal-root')!.innerHTML = '';
    this.dispose = await this.mount(parseRoute());
  }
}
