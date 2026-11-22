// Runs on web.whatsapp.com. When the helper opened this chat, press Send and report back.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(check, ms, every = 300) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = check();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();

  function composeBox() {
    return (
      document.querySelector('#main footer div[contenteditable="true"]') ||
      document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"][data-tab="10"]')
    );
  }

  function sendButton() {
    const icon = document.querySelector('#main footer [data-icon*="send"], footer [data-icon*="send"]');
    if (icon) return icon.closest('button, [role="button"]') || icon;
    return document.querySelector('#main footer button[aria-label="Send"], footer button[aria-label="Send"]');
  }

  // "Phone number shared via url is invalid." (WhatsApp keeps the word "url" in most languages)
  function invalidDialog() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (/url|invalid|غير صالح/i.test(d.textContent || '')) return d;
    }
    return null;
  }

  // The QR login screen: no chat list, a QR code instead.
  const loginScreen = () => !document.querySelector('#side, #pane-side') && document.querySelector('canvas, [data-ref]');

  async function sendOne() {
    let state = await waitFor(() => {
      const box = composeBox();
      if (box && textOf(box)) return 'chat';
      if (invalidDialog()) return 'invalid';
      if (loginScreen()) return 'login';
      return null;
    }, 45000);

    if (state === 'login') {
      // The QR can flash while WhatsApp loads; make sure it stays.
      await sleep(4000);
      const box = composeBox();
      if (box && textOf(box)) state = 'chat';
      else if (invalidDialog()) state = 'invalid';
      else if (loginScreen()) return { status: 'login_needed' };
      else state = await waitFor(() => (composeBox() && textOf(composeBox()) ? 'chat' : invalidDialog() ? 'invalid' : null), 30000);
    }

    if (!state) return { status: 'failed', note: 'The chat did not open in time' };

    if (state === 'invalid') {
      const d = invalidDialog();
      const ok = d && d.querySelector('button, [role="button"]');
      if (ok) ok.click();
      return { status: 'not_on_whatsapp', note: 'This number has no WhatsApp' };
    }

    await sleep(700 + Math.random() * 800);
    const btn = await waitFor(sendButton, 5000);
    if (btn) {
      btn.click();
    } else {
      const box = composeBox();
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }

    const cleared = await waitFor(() => {
      const box = composeBox();
      return box && !textOf(box);
    }, 8000);
    if (!cleared) return { status: 'failed', note: 'Could not press Send' };

    // Give WhatsApp a moment to hand the message to the server (one grey tick) before moving on.
    await waitFor(() => {
      const outs = document.querySelectorAll('#main .message-out');
      const last = outs[outs.length - 1];
      return last && last.querySelector('[data-icon*="check"]');
    }, 15000);
    return { status: 'sent' };
  }

  (async () => {
    let task;
    try {
      task = await chrome.runtime.sendMessage({ type: 'wa-hello' });
    } catch (e) {
      return;
    }
    if (!task || !task.number) return; // a normal WhatsApp Web visit: do nothing
    let result;
    try {
      result = await sendOne();
    } catch (e) {
      result = { status: 'failed', note: String((e && e.message) || e) };
    }
    chrome.runtime.sendMessage({ type: 'wa-result', number: task.number, ...result }).catch(() => {});
  })();
})();
