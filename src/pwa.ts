import { appUrl } from './lib/app-url.js';

// App-shell caching only. Auth, project data and cloud assets are never cached here.
export function registerPwa(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = () => {
    const base = appUrl();
    void navigator.serviceWorker.register(new URL('sw.js', base).href, { scope: base })
      .catch((e) => console.warn('SW registration failed', e));
  };
  // Supabase session restoration can finish after the load event has already fired.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
