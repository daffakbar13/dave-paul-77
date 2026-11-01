import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../i18n.ts';

type Props = { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean };

// Native <dialog>: focus trap, Esc and inert background come from the browser.
export function Modal({ title, onClose, children, footer, wide }: Props) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="modal-title"
    >
      <header className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button type="button" className="x" aria-label={t('Tutup', 'Close')} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </dialog>
  );
}
