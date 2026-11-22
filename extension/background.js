// WhatsApp Bulk Sender Helper: runs the send queue for the Tap to Send page.
//
// Flow: the page sends {numbers, text, minWait, maxWait}. For each number we load
// web.whatsapp.com/send?phone=...&text=... in one WhatsApp tab; whatsapp.js presses Send
// and reports back; then we wait a random minWait–maxWait seconds and do the next one.
// State lives in chrome.storage.session so it survives the service worker going to sleep;
// an alarm wakes us up if a timer was lost.

const WA = 'https://web.whatsapp.com/';
const LOAD_TIMEOUT_MS = 60000;
const MAX_NUMBERS = 200;

let job = null;
let timer = null;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

async function getJob() {
  if (job) return job;
  const saved = await chrome.storage.session.get('job');
  job = saved.job || null;
  return job;
}

async function setJob(j) {
  job = j;
  await chrome.storage.session.set({ job: j });
}

function tellPage(j, msg) {
  if (!j || j.pageTabId == null) return;
  chrome.tabs.sendMessage(j.pageTabId, msg).catch(() => {});
}

function later(ms) {
  clearTimeout(timer);
  timer = setTimeout(wake, ms);
}

async function start(msg, pageTabId) {
  const numbers = [...new Set((msg.numbers || []).map(String))]
    .filter((n) => /^\d{8,15}$/.test(n))
    .slice(0, MAX_NUMBERS);
  const text = String(msg.text || '').trim();
  if (!numbers.length) return { ok: false, error: 'There are no numbers left to send to.' };
  if (!text) return { ok: false, error: 'Write a message first.' };
  const minWait = clamp(Number(msg.minWait) || 10, 5, 120);
  const maxWait = clamp(Number(msg.maxWait) || 20, minWait, 180);
  const old = await getJob();
  if (old && old.running) return { ok: false, error: 'Already sending.' };
  if (old && old.phase === 'sending' && Date.now() < old.deadline) {
    return { ok: false, error: 'Still finishing the last message. Try again in a few seconds.' };
  }
  await setJob({
    running: true,
    pageTabId,
    waTabId: old ? old.waTabId : null,
    numbers,
    pos: 0,
    text,
    minWait,
    maxWait,
    phase: 'idle',
    current: null,
    nextAt: 0,
    deadline: 0,
  });
  chrome.alarms.create('tick', { periodInMinutes: 0.5 });
  step();
  return { ok: true, total: numbers.length };
}

// Stop after the current message. A message that is already being sent is allowed to finish
// (so Continue never sends it twice); its result still reaches the page.
async function stop(reason, type = 'stopped') {
  const j = await getJob();
  if (!j) return;
  j.running = false;
  if (j.phase !== 'sending') {
    j.phase = 'idle';
    j.current = null;
    clearTimeout(timer);
    chrome.alarms.clear('tick');
  }
  await setJob(j);
  tellPage(j, { type, reason });
}

// The current message can't finish (its tab closed): put the number back in the queue.
async function abandonCurrent() {
  const j = await getJob();
  if (!j || j.phase !== 'sending') return;
  const number = j.current;
  j.phase = 'idle';
  j.current = null;
  await setJob(j);
  if (!j.running) {
    clearTimeout(timer);
    chrome.alarms.clear('tick');
  }
  tellPage(j, { type: 'progress', number, status: 'pending' });
}

async function step() {
  const j = await getJob();
  if (!j || !j.running) return;
  if (j.pos >= j.numbers.length) {
    await stop('All messages are done.', 'done');
    return;
  }
  const number = j.numbers[j.pos];
  const url = `${WA}send?phone=${number}&text=${encodeURIComponent(j.text)}`;
  j.phase = 'sending';
  j.current = number;
  j.deadline = Date.now() + LOAD_TIMEOUT_MS;
  await setJob(j);
  tellPage(j, { type: 'progress', number, status: 'sending' });

  try {
    let tabId = j.waTabId;
    if (tabId != null) {
      try {
        await chrome.tabs.update(tabId, { url });
      } catch (e) {
        tabId = null; // the tab is gone
      }
    }
    if (tabId == null) {
      // Reuse an open WhatsApp Web tab: a second one would make WhatsApp ask "Use here?".
      const open = await chrome.tabs.query({ url: WA + '*' });
      if (open.length) {
        tabId = open[0].id;
        await chrome.tabs.update(tabId, { url });
      } else {
        tabId = (await chrome.tabs.create({ url, active: true })).id;
      }
    }
    j.waTabId = tabId;
    await setJob(j);
  } catch (e) {
    await finishOne(number, 'failed', 'Could not open WhatsApp Web: ' + e.message);
    return;
  }
  later(LOAD_TIMEOUT_MS + 1000);
}

async function finishOne(number, status, note) {
  const j = await getJob();
  if (!j || j.phase !== 'sending' || j.current !== number) return;

  if (!j.running) {
    // Paused while this message was going out: record it, don't start the next one.
    j.phase = 'idle';
    j.current = null;
    await setJob(j);
    clearTimeout(timer);
    chrome.alarms.clear('tick');
    if (status === 'login_needed') tellPage(j, { type: 'progress', number, status: 'pending' });
    else tellPage(j, { type: 'result', number, status, note: note || '' });
    return;
  }

  if (status === 'login_needed') {
    j.running = false;
    j.phase = 'idle';
    j.current = null;
    await setJob(j);
    clearTimeout(timer);
    chrome.alarms.clear('tick');
    tellPage(j, { type: 'progress', number, status: 'pending' });
    tellPage(j, { type: 'login-needed' });
    return;
  }

  tellPage(j, { type: 'result', number, status, note: note || '' });
  j.pos += 1;
  j.current = null;
  if (j.pos >= j.numbers.length) {
    await setJob(j);
    await stop('All messages are done.', 'done');
    return;
  }
  const ms = Math.round((j.minWait + Math.random() * (j.maxWait - j.minWait)) * 1000);
  j.phase = 'waiting';
  j.nextAt = Date.now() + ms;
  await setJob(j);
  tellPage(j, { type: 'waiting', nextAt: j.nextAt });
  later(ms);
}

async function wake() {
  const j = await getJob();
  if (!j) return;
  if (j.phase === 'sending' && Date.now() >= j.deadline) {
    finishOne(j.current, 'failed', 'WhatsApp Web did not open the chat in time');
  } else if (j.running && j.phase === 'waiting' && Date.now() >= j.nextAt - 250) {
    step();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') wake();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const j = await getJob();
  if (!j) return;
  if (tabId === j.pageTabId && j.running) {
    await stop('The Tap to Send page was closed.');
  } else if (tabId === j.waTabId) {
    j.waTabId = null;
    await setJob(j);
    await abandonCurrent();
    if (j.running) await stop('The WhatsApp tab was closed. Click Continue automatic to go on.');
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;
  (async () => {
    switch (msg && msg.type) {
      case 'start':
        return start(msg, tabId);
      case 'stop':
        await stop('Paused. Click Continue automatic to go on.');
        return { ok: true };
      case 'status': {
        const j = await getJob();
        return { running: !!(j && j.running) };
      }
      case 'wa-hello': {
        // whatsapp.js asks whether this tab should send something right now
        const j = await getJob();
        if (j && j.running && j.phase === 'sending' && tabId === j.waTabId) return { number: j.current, text: j.text };
        return {};
      }
      case 'wa-result':
        await finishOne(msg.number, msg.status, msg.note);
        return { ok: true };
      default:
        return {};
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // answer asynchronously
});
