// Runs synchronously from <head> so the saved theme applies before first paint.
(function () {
  var t = localStorage.getItem('gpxlib-theme');
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

// Offline support. On localhost the worker is opt-in (?sw=1) so edits aren't masked by cached files.
if ('serviceWorker' in navigator) {
  var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!isLocal || /[?&]sw=1\b/.test(location.search)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
}
