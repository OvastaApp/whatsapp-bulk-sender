'use strict';

const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT) || 3000;
const MAX_NUMBERS = 200;
const MAX_FILE_MB = 30;
// Keep the saved login in a short path. If this folder sits deep on disk, Chrome's WhatsApp data
// goes past Windows' 260-character path limit and WhatsApp Web logs out straight away.
const SESSION_DIR = process.env.SESSION_DIR || path.join(require('os').homedir(), '.wa-sender');

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (min, max) => min + Math.random() * (max - min);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// If the app was killed hard last time, its hidden browser may still hold the saved login open.
function closeLeftoverBrowsers() {
  if (process.platform !== 'win32') return;
  const dir = path.join(SESSION_DIR, 'session').replace(/'/g, "''");
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') " +
    `-and $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`, {
      stdio: 'ignore',
      timeout: 20000,
    });
  } catch {
    // not critical
  }
}

// The library's built-in browser ID is Chrome 101. Report the real installed version instead.
function modernUserAgent(executablePath) {
  let major = 142;
  try {
    const versions = fs
      .readdirSync(path.dirname(executablePath))
      .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
      .map((n) => Number(n.split('.')[0]));
    if (versions.length) major = Math.max(...versions);
  } catch {
    // keep the default
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// "0101 234 5678" + country code 20 -> "201012345678"
function normalizeNumber(raw, countryCode) {
  const s = raw.trim();
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (s.startsWith('+')) {
    // already international
  } else if (d.startsWith('00')) {
    d = d.slice(2);
  } else if (d.startsWith('0') && countryCode) {
    d = countryCode + d.slice(1);
  }
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

// Splits on new lines, commas and semicolons. Also splits "0101... 0102..." on one line.
function parseNumbers(text, countryCode) {
  const pieces = [];
  for (const part of String(text || '').split(/[\r\n,;]+/)) {
    const p = part.trim();
    if (!p) continue;
    const tokens = p.split(/\s+/);
    if (tokens.length > 1 && tokens.every((t) => t.replace(/\D/g, '').length >= 8)) pieces.push(...tokens);
    else pieces.push(p);
  }
  const seen = new Set();
  const items = [];
  let duplicates = 0;
  for (const raw of pieces) {
    const number = normalizeNumber(raw, countryCode);
    const key = number || raw;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    items.push({
      raw,
      number,
      status: number ? 'queued' : 'invalid',
      note: number ? '' : 'Not a valid phone number',
      time: null,
    });
  }
  return { items, duplicates };
}

// ---------- shared state + live updates (Server-Sent Events) ----------

const state = {
  wa: 'starting', // starting | qr | loading | ready | disconnected | error
  qr: null,
  loading: null,
  me: null,
  error: null,
  job: null,
};

const listeners = new Set();
const snapshot = () => ({ ...state, maxNumbers: MAX_NUMBERS, maxFileMb: MAX_FILE_MB });
function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of listeners) res.write(msg);
}

// ---------- WhatsApp client ----------

// WhatsApp sometimes sets a "wa_ul" cookie that sends a logged-out browser to /login/, a newer page
// the library can't read, so it waits forever. While logged out we drop that cookie before the page
// loads. If WhatsApp still lands on /login/, we drop it and reload the normal page, which shows the QR.
const LOGGED_IN_MARKER = path.join(SESSION_DIR, 'logged-in');

async function dropLoginCookie(page) {
  const cdp = await page.createCDPSession();
  try {
    const { cookies } = await cdp.send('Network.getAllCookies');
    for (const c of cookies) {
      if (c.name === 'wa_ul') await cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

class SenderAuth extends LocalAuth {
  async afterBrowserInitialized() {
    await super.afterBrowserInitialized();
    const page = this.client && this.client.pupPage;
    if (!page) return;
    if (!fs.existsSync(LOGGED_IN_MARKER)) await dropLoginCookie(page).catch(() => {});
    if (page.__loginFix) return;
    page.__loginFix = true;
    let fixes = 0;
    page.on('framenavigated', async (frame) => {
      if (frame.parentFrame() !== null) return;
      let pathname = '';
      try {
        pathname = new URL(frame.url()).pathname;
      } catch {
        return;
      }
      if (!pathname.startsWith('/login') || fixes >= 3) return;
      fixes++;
      try {
        // Let the library finish its own first page load, or its loader never resumes.
        for (let i = 0; i < 120 && !this.client._framenavigatedRegistered; i++) await sleep(500);
        await sleep(1000);
        await dropLoginCookie(page);
        console.log('WhatsApp opened its new login page; switching back to the QR page.');
        await page.goto('https://web.whatsapp.com/', { waitUntil: 'load', timeout: 60000 });
      } catch (e) {
        console.warn('Could not switch to the QR page:', e.message);
      }
    });
  }
}

let client = null;
let restarting = false;

function createClient() {
  const executablePath = findBrowser();
  if (!executablePath) {
    throw new Error('Google Chrome or Microsoft Edge was not found. Install Chrome, or set CHROME_PATH.');
  }
  const c = new Client({
    authStrategy: new SenderAuth({ dataPath: SESSION_DIR }),
    authTimeoutMs: 120000, // slow internet: give WhatsApp Web up to 2 minutes to load
    userAgent: modernUserAgent(executablePath),
    puppeteer: {
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  c.on('qr', async (qr) => {
    if (state.wa !== 'qr') console.log('Waiting for you to scan the QR code in the browser page.');
    state.wa = 'qr';
    state.error = null;
    state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
    broadcast();
  });
  c.on('loading_screen', (percent) => {
    state.wa = 'loading';
    state.loading = Number(percent) || null;
    broadcast();
  });
  c.on('authenticated', () => {
    state.wa = 'loading';
    state.qr = null;
    broadcast();
  });
  c.on('auth_failure', (msg) => {
    state.wa = 'error';
    state.error = `Login failed: ${msg}. Click "Log out" and scan again.`;
    broadcast();
  });
  c.on('ready', () => {
    state.wa = 'ready';
    state.qr = null;
    state.loading = null;
    state.error = null;
    state.me = c.info && c.info.wid ? c.info.wid.user : null;
    try {
      fs.writeFileSync(LOGGED_IN_MARKER, new Date().toISOString());
    } catch {
      // not critical
    }
    console.log(`WhatsApp connected as +${state.me}`);
    broadcast();
  });
  c.on('disconnected', (reason) => {
    console.log('WhatsApp disconnected:', reason);
    fs.rmSync(LOGGED_IN_MARKER, { force: true });
    state.wa = 'disconnected';
    state.me = null;
    broadcast();
    restartClient();
  });
  return c;
}

let startAttempts = 0;

async function startClient() {
  state.wa = 'starting';
  state.qr = null;
  broadcast();
  try {
    client = createClient();
    await client.initialize();
    startAttempts = 0;
  } catch (e) {
    const reason = (e && e.message) || String(e);
    console.error('Could not start WhatsApp:', reason);
    startAttempts++;
    if (startAttempts <= 3 && !/not found/i.test(reason)) {
      state.error = `WhatsApp is slow to load (${reason}). Trying again (${startAttempts}/3)…`;
      broadcast();
      restartClient();
      return;
    }
    state.wa = 'error';
    state.error = `Could not start WhatsApp: ${reason}. Check your internet, then close and start the app again.`;
    broadcast();
  }
}

async function restartClient({ clearSession = false } = {}) {
  if (restarting) return;
  restarting = true;
  try {
    if (client) await client.destroy().catch(() => {});
    if (clearSession) {
      try {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (e) {
        console.warn('Could not delete the saved login:', e.message);
      }
    }
    await sleep(2000);
  } finally {
    restarting = false;
  }
  startClient();
}

// ---------- sending ----------

async function waitOrStop(ms, job) {
  const end = Date.now() + ms;
  while (Date.now() < end && !job.stopRequested) await sleep(250);
}

async function runJob(job, message, media) {
  for (let i = 0; i < job.items.length; i++) {
    const item = job.items[i];
    if (item.status !== 'queued') continue;
    if (job.stopRequested) break;
    if (state.wa !== 'ready') {
      job.error = 'WhatsApp disconnected, so sending stopped.';
      break;
    }

    item.status = 'sending';
    broadcast();

    let attempted = false;
    try {
      const id = await client.getNumberId(item.number);
      if (!id) {
        item.status = 'not_on_whatsapp';
        item.note = 'This number has no WhatsApp';
      } else {
        attempted = true;
        const opts = { sendSeen: false };
        if (media) {
          if (message) opts.caption = message;
          await client.sendMessage(id._serialized, media, opts);
        } else {
          await client.sendMessage(id._serialized, message, opts);
        }
        item.status = 'sent';
        item.note = '';
      }
    } catch (e) {
      item.status = 'failed';
      item.note = String((e && e.message) || e).slice(0, 200);
    }
    item.time = new Date().toISOString();
    broadcast();

    const more = job.items.slice(i + 1).some((x) => x.status === 'queued');
    if (more && !job.stopRequested) {
      const ms = attempted ? randBetween(job.minDelay, job.maxDelay) * 1000 : randBetween(2, 4) * 1000;
      job.nextAt = Date.now() + ms;
      broadcast();
      await waitOrStop(ms, job);
      job.nextAt = null;
    }
  }

  for (const it of job.items) {
    if (it.status === 'queued' || it.status === 'sending') {
      it.status = 'skipped';
      it.note = job.error || 'Stopped before sending';
    }
  }
  job.running = false;
  job.nextAt = null;
  job.finishedAt = Date.now();
  broadcast();
  console.log('Finished sending.');
}

// ---------- web server ----------

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    listeners.delete(res);
  });
});

app.post('/api/send', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? `The file is bigger than ${MAX_FILE_MB} MB.` : err.message });
    }
    if (state.wa !== 'ready') return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
    if (state.job && state.job.running) return res.status(409).json({ error: 'A send is already running.' });

    const message = String(req.body.message || '').trim();
    const countryCode = String(req.body.countryCode || '').replace(/\D/g, '');
    const minDelay = clamp(Number(req.body.minDelay) || 10, 3, 600);
    const maxDelay = clamp(Number(req.body.maxDelay) || 20, minDelay, 900);
    const { items, duplicates } = parseNumbers(req.body.numbers, countryCode);

    if (!items.length) return res.status(400).json({ error: 'Add at least one phone number.' });
    if (items.length > MAX_NUMBERS) {
      return res.status(400).json({ error: `You added ${items.length} numbers. The limit is ${MAX_NUMBERS}.` });
    }
    if (!items.some((x) => x.status === 'queued')) {
      return res.status(400).json({ error: 'None of the numbers look valid.' });
    }
    if (!message && !req.file) return res.status(400).json({ error: 'Write a message or attach a file.' });

    let media = null;
    if (req.file) {
      const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      media = new MessageMedia(
        req.file.mimetype || 'application/octet-stream',
        req.file.buffer.toString('base64'),
        fileName,
        req.file.size
      );
    }

    const job = {
      id: Date.now(),
      items,
      total: items.length,
      duplicates,
      minDelay,
      maxDelay,
      fileName: media ? media.filename : null,
      running: true,
      stopRequested: false,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      nextAt: null,
    };
    state.job = job;
    broadcast();
    res.json({ ok: true, total: items.length, duplicates });

    runJob(job, message, media).catch((e) => {
      console.error(e);
      job.running = false;
      job.error = e.message;
      broadcast();
    });
  });
});

app.post('/api/stop', (req, res) => {
  if (state.job && state.job.running) {
    state.job.stopRequested = true;
    broadcast();
  }
  res.json({ ok: true });
});

app.post('/api/clear', (req, res) => {
  if (state.job && state.job.running) return res.status(409).json({ error: 'Stop the current send first.' });
  state.job = null;
  broadcast();
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  if (state.job && state.job.running) return res.status(409).json({ error: 'Stop the current send first.' });
  res.json({ ok: true });
  if (client && state.wa === 'ready') {
    try {
      await client.logout();
    } catch (e) {
      console.warn('Logout warning:', e.message);
    }
  }
  state.me = null;
  restartClient({ clearSession: true });
});

// The library throws stray errors while its hidden browser restarts. Log one line, keep running.
const oneLine = (e) => String((e && e.message) || e).split('\n')[0];
process.on('unhandledRejection', (e) => console.warn('(ignored)', oneLine(e)));
process.on('uncaughtException', (e) => console.warn('(ignored)', oneLine(e)));

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nWhatsApp Sender is running at ${url}`);
  console.log('Keep this window open while sending. Press Ctrl+C to quit.\n');
  if (!process.env.NO_OPEN && !process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
  closeLeftoverBrowsers();
  startClient();
});
