export interface ModalAction {
  label: string;
  kind?: 'primary' | 'ghost' | 'danger';
  onClick?: () => void | Promise<void>;
  keepOpen?: boolean;
}

export function openModal(opts: { title: string; body: HTMLElement | string; actions?: ModalAction[]; wide?: boolean }): HTMLElement {
  const root = document.getElementById('modal-root') as HTMLElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = `modal${opts.wide ? ' modal-wide' : ''}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', opts.title);
  const titleRow = document.createElement('div');
  titleRow.className = 'modal-title';
  const h = document.createElement('h3');
  h.textContent = opts.title;
  const x = document.createElement('button');
  x.className = 'btn btn-icon';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '✕';
  x.onclick = () => closeModal();
  titleRow.append(h, x);
  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal-body';
  if (typeof opts.body === 'string') bodyEl.innerHTML = opts.body;
  else bodyEl.appendChild(opts.body);
  modal.append(titleRow, bodyEl);
  if (opts.actions?.length) {
    const row = document.createElement('div');
    row.className = 'modal-actions';
    for (const a of opts.actions) {
      const b = document.createElement('button');
      b.className = `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'}`;
      b.textContent = a.label;
      b.onclick = async () => {
        await a.onClick?.();
        if (!a.keepOpen) closeModal();
      };
      row.appendChild(b);
    }
    modal.appendChild(row);
  }
  overlay.appendChild(modal);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeModal();
  });
  root.innerHTML = '';
  root.appendChild(overlay);
  const first = modal.querySelector('input,button.btn-primary') as HTMLElement | null;
  first?.focus();
  return bodyEl;
}

export function closeModal(): void {
  const root = document.getElementById('modal-root') as HTMLElement;
  root.innerHTML = '';
}

export function confirmModal(title: string, message: string, confirmLabel: string, onConfirm: () => void | Promise<void>): void {
  const body = document.createElement('p');
  body.textContent = message;
  openModal({
    title,
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: confirmLabel, kind: 'primary', onClick: onConfirm },
    ],
  });
}
