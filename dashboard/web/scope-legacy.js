// Scopes the hosted views' stylesheets (dashboard/public/*.css) under .lg in
// the app bundle, so a rule written for them can never reach a React
// component. Pure; the tests import it (dashboard/tests/web-app.test.js).
//   .card x                 -> .lg .card x
//   :root[data-theme] .x    -> :root[data-theme] .lg .x   (the theme stays on the root)
//   body                    -> .lg                         (its type and color)
//   html, :root alone       -> dropped (tokens.css owns the root)
//   body.split …            -> dropped (the old page frame, replaced by the shell)
export function scopeSelector(sel) {
  const s = sel.trim();
  const root = s.match(/^((?::root|html)(?:\[[^\]]*\]|:not\([^)]*\))*)(.*)$/s);
  if (root) {
    const rest = root[2].trim();
    if (!rest) return null;
    if (/^body\b/.test(rest)) return null;
    return `${root[1]} .lg ${rest}`;
  }
  if (/^body\b/.test(s)) return s === 'body' ? '.lg' : null;
  return `.lg ${s}`;
}

// The PostCSS plugin: `isLegacy(file)` says which files it applies to.
export function scopeLegacy(isLegacy) {
  return {
    postcssPlugin: 'cr-scope-legacy',
    Once(root) {
      const file = root.source && root.source.input && root.source.input.file;
      if (!file || !isLegacy(file)) return;
      root.walkRules((rule) => {
        if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        const out = rule.selectors.map(scopeSelector).filter(Boolean);
        if (!out.length) {
          rule.remove();
          return;
        }
        // The page's own background and width belong to the shell.
        if (out.length === 1 && out[0] === '.lg') rule.walkDecls(/^(background|background-color|overflow-x|min-width)$/, (d) => d.remove());
        rule.selectors = out;
      });
    },
  };
}
