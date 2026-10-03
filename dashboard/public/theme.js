// The color theme, chosen per browser in Settings and applied before the first
// paint (a plain script, so it runs before the stylesheet's first use). Dark is
// the default; "light" and "system" (follow the device) are the other choices.
(function () {
  var t = null;
  try {
    t = JSON.parse(window.localStorage.getItem('cr.theme'));
  } catch (_) { /* private window or blocked storage: the default */ }
  if (t === 'light' || t === 'system') document.documentElement.setAttribute('data-theme', t);
}());
