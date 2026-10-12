// Runs only in the blank old-origin health document opened by our background.
// It reads business storage only during a locally started migration session.
chrome.runtime.onMessage.addListener((value, sender) => {
  if (sender.id !== chrome.runtime.id || location.origin !== 'http://127.0.0.1:5174'
    || location.pathname !== '/local-app/health' || window.top !== window
    || value?.op !== 'guan-port-migration-export' || typeof value.url !== 'string') return;
  const url = new URL(value.url);
  if (url.origin !== 'http://127.0.0.1:8888' || !/^\/migration-[a-f0-9-]{36}\/export\.js$/.test(url.pathname)) return;
  const script = document.createElement('script'); script.type = 'module'; script.src = url.href;
  document.documentElement.appendChild(script);
});
