// Apply the saved theme before the first paint (no flash). The shell reads and writes the same key.
try {
  var t = localStorage.getItem('open-observe.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
