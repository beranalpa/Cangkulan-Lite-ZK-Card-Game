import { useState, useEffect, useCallback, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
//  Toast Notification System
//  Corner-anchored auto-dismiss toasts that don't shift layout.
// ═══════════════════════════════════════════════════════════════════════════════

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
  /** Optional retry callback — renders a Retry button on the toast */
  onRetry?: () => void;
}

let nextId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType = 'info', duration = 4000, onRetry?: () => void) => {
    const id = ++nextId;
    setToasts(prev => [...prev, { id, message, type, duration, onRetry }]);
    return id;
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const success = useCallback((msg: string, duration?: number) => addToast(msg, 'success', duration), [addToast]);
  const error = useCallback((msg: string, duration?: number, onRetry?: () => void) => addToast(msg, 'error', duration ?? 8000, onRetry), [addToast]);
  const info = useCallback((msg: string, duration?: number) => addToast(msg, 'info', duration), [addToast]);

  return { toasts, addToast, removeToast, success, error, info };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Single Toast Item
// ═══════════════════════════════════════════════════════════════════════════════

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 300);
    }, toast.duration);
    return () => clearTimeout(timerRef.current);
  }, [toast.id, toast.duration, onDismiss]);

  const handleClick = () => {
    clearTimeout(timerRef.current);
    setExiting(true);
    setTimeout(() => onDismiss(toast.id), 300);
  };

  const styles: Record<ToastType, { bg: string; border: string; icon: string; text: string }> = {
    success: {
      bg: 'bg-emerald-50',
      border: 'border-emerald-300',
      icon: '✓',
      text: 'text-emerald-800',
    },
    error: {
      bg: 'bg-red-50',
      border: 'border-red-300',
      icon: '⚠',
      text: 'text-red-800',
    },
    info: {
      bg: 'bg-blue-50',
      border: 'border-blue-300',
      icon: 'ℹ',
      text: 'text-blue-800',
    },
  };

  const s = styles[toast.type];

  return (
    <div
      role="alert"
      onClick={handleClick}
      className={`
        ${s.bg} ${s.border} ${s.text}
        border-2 rounded-xl px-4 py-3 shadow-lg cursor-pointer
        flex items-start gap-2 max-w-sm w-full backdrop-blur-sm
        transition-all duration-300 ease-out
        ${exiting ? 'toast-exit' : 'toast-enter'}
      `}
    >
      <span className="text-base shrink-0 mt-0.5">{s.icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-snug">{toast.message}</p>
        {toast.onRetry && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toast.onRetry?.();
              handleClick();
            }}
            className="mt-1.5 px-3 py-1 rounded-lg text-xs font-bold border transition-colors bg-white/80 border-red-300 text-red-700 hover:bg-red-100"
          >
            ↻ Retry
          </button>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); handleClick(); }}
        className="shrink-0 text-xs opacity-50 hover:opacity-100 transition-opacity bg-transparent border-0 p-0 shadow-none"
        style={{ background: 'none', border: 'none', padding: '2px', minWidth: 'auto' }}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Toast Container (renders in fixed corner)
// ═══════════════════════════════════════════════════════════════════════════════

export function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col-reverse gap-2 pointer-events-none" style={{ maxWidth: '22rem' }}>
      {toasts.slice(-5).map(toast => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}
