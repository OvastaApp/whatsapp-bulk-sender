// Runs on the Tap to Send page and passes messages between the page and the helper.
(() => {
  const version = chrome.runtime.getManifest().version;
  const target = location.origin === 'null' ? '*' : location.origin;
  const toPage = (msg) => window.postMessage({ source: 'wa-helper', ...msg }, target);

  // Lets the page see the helper even before its own script runs.
  document.documentElement.setAttribute('data-wa-helper', version);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'tap-to-send') return;
    const { type } = e.data;
    if (!['start', 'stop', 'status'].includes(type)) return;
    chrome.runtime
      .sendMessage({ ...e.data })
      .then((res) => toPage({ type: 'reply', for: type, ...(res || {}) }))
      .catch((err) => toPage({ type: 'error', message: String((err && err.message) || err) }));
  });

  chrome.runtime.onMessage.addListener((msg) => {
    toPage(msg);
  });

  toPage({ type: 'hello', version });
})();
