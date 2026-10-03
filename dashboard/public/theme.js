// The color theme, chosen per browser in Settings and applied before the first
// paint (a plain script, so it runs before the stylesheet's first use). Light
// is the default; "dark" and "system" (follow the device) are the choices.
// Nothing stored means light, also for a browser that used the dark default.
(function () {
  var t = null;
  try {
    t = JSON.parse(window.localStorage.getItem('cr.theme'));
  } catch (_) { /* private window or blocked storage: the default */ }
  if (t === 'dark' || t === 'system') document.documentElement.setAttribute('data-theme', t);
}());
