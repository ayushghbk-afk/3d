import './styles.css';
import { auth } from './lib/auth.js';
import { Router, type Route } from './ui/router.js';
import { mountDashboard, mountLogin, handleJoinRoute } from './ui/dashboard.js';
import { toast } from './ui/toast.js';
import { registerPwa } from './pwa.js';

async function boot(): Promise<void> {
  const app = document.getElementById('app') as HTMLElement;
  app.innerHTML = '<div class="auth-wrap"><div class="loading">Loading Web 3D Studio…</div></div>';

  try {
    await auth.init();
    if (auth.error.get()) toast(auth.error.get() as string, 'warn');
  } catch (e) {
    console.error('auth init failed', e);
  }

  const router = new Router(async (route: Route) => {
    if (route.name === 'join') {
      void handleJoinRoute(route.projectId, route.code);
      app.innerHTML = '<div class="auth-wrap"><div class="loading">Joining project…</div></div>';
      return () => undefined;
    }
    if (route.name === 'login') return mountLogin(app);
    if (route.name === 'editor') {
      // Lazy-load three.js only when the editor opens (§45 perf budget)
      app.innerHTML = '<div class="auth-wrap"><div class="loading">Loading 3D editor…</div></div>';
      try {
        const { mountEditor } = await import('./ui/editor.js');
        // user may have navigated away while the chunk loaded
        if (!window.location.hash.startsWith(`#/p/${route.projectId}`)) return () => undefined;
        return mountEditor(app, route.projectId);
      } catch (e) {
        toast(`Failed to open editor: ${(e as Error).message}`, 'error');
        window.location.hash = '#/';
        return () => undefined;
      }
    }
    return mountDashboard(app);
  });
  router.start();
  registerPwa();
}

void boot();
