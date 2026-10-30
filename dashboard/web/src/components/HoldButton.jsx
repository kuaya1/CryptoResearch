// Hold to confirm (the Architecture restyle, Eric, 2026-10-29): Mark
// reviewed asks for a hold (--hold-ms, 800ms since UI v3), a green sweep
// filling the button, so a stray click never records a review. Letting go early does nothing.
// Holding Enter or Space works the same as holding the pointer. A click with
// no pointer or key hold behind it (detail 0: the command menu, a screen
// reader's activation, a script) is already a deliberate act, like R or
// Ctrl+Enter, and confirms at once. The handler is the caller's, unchanged.
import { useEffect, useRef, useState } from 'react';

// The hold lasts --hold-ms (tokens.css), read when a hold starts, so the
// timer and the sweep's transition always agree.
const holdMs = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hold-ms'));
  return Number.isFinite(v) && v > 0 ? v : 800;
};
const KEYS = new Set(['Enter', ' ']);

export function HoldButton({ onConfirm, className = '', disabled = false, title, children, ...rest }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef(null);
  const live = useRef(false);
  const fire = useRef(onConfirm);
  fire.current = onConfirm;

  const start = () => {
    if (disabled || live.current) return;
    live.current = true;
    setHolding(true);
    timer.current = setTimeout(() => {
      live.current = false;
      setHolding(false);
      fire.current();
    }, holdMs());
  };
  const cancel = () => {
    if (!live.current) return;
    clearTimeout(timer.current);
    live.current = false;
    setHolding(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);

  const plain = (e) => !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-hold ${className}${holding ? ' is-holding' : ''}`.trim()}
      disabled={disabled}
      title={title ? `${title} · Press and hold to confirm` : 'Press and hold to confirm'}
      onPointerDown={(e) => { if (e.button === 0) start(); }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => { if (live.current) e.preventDefault(); }}
      onKeyDown={(e) => {
        if (!KEYS.has(e.key) || !plain(e)) return;
        e.preventDefault();
        if (!e.repeat) start();
      }}
      onKeyUp={(e) => { if (KEYS.has(e.key)) { e.preventDefault(); cancel(); } }}
      onBlur={cancel}
      onClick={(e) => { if (e.detail === 0 && !live.current && !disabled) fire.current(); }}
    >
      {children}
    </button>
  );
}
