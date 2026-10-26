import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({ open, onClose, title, children, footer, width = 620 }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="modal-title" style={{ maxWidth: width }}>
        <div className="modal-header">
          <h2 id="modal-title" style={{ fontSize: '1.35rem', margin: 0 }}>{title}</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={18} /></button>
        </div>
        {children}
        {footer && <div className="row-wrap" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger = false }: {
  open: boolean; onClose: () => void; onConfirm: () => void | Promise<void>;
  title: string; message: string; confirmLabel?: string; danger?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={460} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => void onConfirm()}>{confirmLabel}</button>
    </>}>
      <p className="soft">{message}</p>
    </Modal>
  );
}
