import { useState } from 'react';

// A project's logo: CoinGecko's own image, cached and served by this desk
// (/api/logos; the page never calls an outside image host), on a light plate
// in both themes. Without one, or while it loads, a monogram in one neutral
// tone. One size per place, one fine ring.
export function Logo({ p, size = 28 }) {
  const m = (p && p.market) || {};
  const label = String((p && (p.symbol || p.name)) || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const [state, setState] = useState({ src: null, ok: false });
  const src = m.logo_url || null;
  const ok = state.src === src && state.ok;
  return (
    <span className={`logo${ok ? ' has-img' : ''}`} style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)) }} aria-hidden="true">
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          decoding="async"
          className={ok ? '' : 'loading'}
          onLoad={() => setState({ src, ok: true })}
          onError={() => setState({ src, ok: false })}
        />
      ) : null}
      {ok ? null : <span className="logo-mono">{label}</span>}
    </span>
  );
}
