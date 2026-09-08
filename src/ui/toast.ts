export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export function toast(msg: string, kind: ToastKind = 'info', ms = 3500): void {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
  while (root.children.length > 4) root.firstChild?.remove();
}
