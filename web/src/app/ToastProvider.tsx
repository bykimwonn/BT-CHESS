import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type ToastKind = 'info' | 'success' | 'error';
interface ToastItem { id: number; kind: ToastKind; title: string; message?: string }
interface ToastValue { push: (kind: ToastKind, title: string, message?: string) => void; success: (title: string, message?: string) => void; error: (title: string, message?: string) => void; info: (title: string, message?: string) => void }

const ToastContext = createContext<ToastValue | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const remove = useCallback((id: number) => setItems((list) => list.filter((item) => item.id !== id)), []);
  const push = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = nextId++;
    setItems((list) => [...list.slice(-3), { id, kind, title, message }]);
    window.setTimeout(() => remove(id), 6000);
  }, [remove]);
  const value = useMemo<ToastValue>(() => ({
    push,
    success: (title, message) => push('success', title, message),
    error: (title, message) => push('error', title, message),
    info: (title, message) => push('info', title, message),
  }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            <div className="spread">
              <strong>{item.title}</strong>
              <button className="btn btn-ghost btn-sm" onClick={() => remove(item.id)} aria-label="Dismiss notification">×</button>
            </div>
            {item.message && <div className="small soft">{item.message}</div>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
