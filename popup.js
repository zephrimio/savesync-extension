const hdrVersionEl = document.getElementById('hdrVersion');
if (hdrVersionEl) hdrVersionEl.textContent = 'v' + chrome.runtime.getManifest().version;

const tilesEl      = document.getElementById('tiles');
const chipsEl      = document.getElementById('chips');
const otherChip    = document.getElementById('otherChip');
const otherInput   = document.getElementById('otherInput');
const fetchBtn     = document.getElementById('fetch');
const ctaLabel     = fetchBtn.querySelector('.cta-label');

const hdrOnEl      = document.getElementById('hdrOn');
const detectedEl   = document.getElementById('detected');
const countAuxEl   = document.getElementById('countAux');

const statusCard   = document.getElementById('statusCard');
const statusIcon   = document.getElementById('statusIcon');
const statusText   = document.getElementById('statusText');
const statusMeta   = document.getElementById('statusMeta');
const statusSub    = document.getElementById('statusSub');
const progressWrap = document.getElementById('progressWrap');
const progressBar  = document.getElementById('progressBar');
const runAgainBtn  = document.getElementById('runAgain');

const PLATFORM_NAMES = { x: 'X', rednote: 'RedNote', youtube: 'YouTube', all: 'All' };

let selectedPlatform = 'x';
let selectedCount    = 100;
let detectedPlatform = null;

// -------------------------------------------------------------------------
// Tile & chip interactions
// -------------------------------------------------------------------------

tilesEl.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  setPlatform(tile.dataset.platform);
});

chipsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  setCount(parseInt(chip.dataset.count, 10), { clearOther: true });
});

otherChip.addEventListener('click', () => {
  otherInput.hidden = false;
  otherInput.focus();
  // Unmark the preset chips so "Other" visually owns the selection.
  for (const chip of chipsEl.querySelectorAll('.chip')) chip.classList.remove('selected');
  otherChip.classList.add('selected');
});

otherInput.addEventListener('input', () => {
  const n = parseInt(otherInput.value, 10);
  if (Number.isFinite(n) && n > 0) {
    selectedCount = n;
    countAuxEl.textContent = `Most recent ${formatCount(n)}`;
  }
});

function setPlatform(p) {
  selectedPlatform = p;
  for (const tile of tilesEl.querySelectorAll('.tile')) {
    tile.classList.toggle('selected', tile.dataset.platform === p);
  }
  hdrOnEl.textContent = `On ${PLATFORM_NAMES[p] || '—'}`;
}

function setCount(n, { clearOther = false } = {}) {
  selectedCount = n;
  for (const chip of chipsEl.querySelectorAll('.chip')) {
    chip.classList.toggle('selected', parseInt(chip.dataset.count, 10) === n);
  }
  otherChip.classList.remove('selected');
  if (clearOther) {
    otherInput.hidden = true;
    otherInput.value = '';
  }
  countAuxEl.textContent = `Most recent ${formatCount(n)}`;
}

function formatCount(n) {
  return n >= 1000 ? n.toLocaleString() : String(n);
}

// -------------------------------------------------------------------------
// Active-tab platform detection → pre-select + "Detected:" label
// -------------------------------------------------------------------------

(async () => {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    detectedPlatform = detectPlatform(active?.url || '');
    const label = detectedPlatform ? PLATFORM_NAMES[detectedPlatform] : 'none';
    detectedEl.textContent = label;
    if (detectedPlatform) {
      setPlatform(detectedPlatform);
      const tile = tilesEl.querySelector(`.tile[data-platform="${detectedPlatform}"]`);
      tile?.classList.add('is-detected');
    }
  } catch {
    detectedEl.textContent = 'none';
  }
})();

function detectPlatform(url) {
  if (/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(url)) return 'x';
  if (/^https?:\/\/(www\.)?(xiaohongshu|rednote)\.com\//.test(url)) return 'rednote';
  if (/^https?:\/\/(www\.|m\.)?youtube\.com\//.test(url)) return 'youtube';
  return null;
}

// -------------------------------------------------------------------------
// Fetch CTA
// -------------------------------------------------------------------------

fetchBtn.addEventListener('click', async () => {
  // Pre-flight: per-platform check that (a) a tab on the platform is open
  // and (b) the user is logged in. Without this, the background script
  // throws mid-fetch and the user sees a vague error.
  const check = await preflightCheck(selectedPlatform);
  if (!check.ok) {
    showWarning(check.warning);
    return;
  }

  setRunning(true);
  showStatus({ kind: 'running', text: `Starting ${PLATFORM_NAMES[selectedPlatform]}…` });
  chrome.runtime.sendMessage({
    type: 'fetch',
    platform: selectedPlatform,
    count: selectedCount,
  });
});

async function preflightCheck(platform) {
  if (platform === 'all') {
    for (const p of ['x', 'rednote', 'youtube']) {
      const r = await preflightCheck(p);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (platform === 'x')       return await preflightX();
  if (platform === 'rednote') return await preflightRedNote();
  if (platform === 'youtube') return await preflightYouTube();
  return { ok: true };
}

async function preflightX() {
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://www.x.com/*', 'https://twitter.com/*', 'https://www.twitter.com/*'],
  });
  if (tabs.length === 0) {
    return {
      ok: false,
      warning: {
        title: 'Open X first',
        body: 'The extension needs an x.com tab (signed in) to read your bookmarks. Open x.com, sign in if you aren\u2019t already, then click Fetch again.',
        actions: [['Open X', 'https://x.com/home']],
      },
    };
  }
  // ct0 is the CSRF cookie x.com sets only for logged-in sessions. It's
  // readable from page context (not HttpOnly).
  const loggedIn = await evalInTab(tabs[0].id, () => /(?:^|;\s*)ct0=/.test(document.cookie));
  if (loggedIn === false) {
    return {
      ok: false,
      warning: {
        title: 'Sign in to X',
        body: "You're on x.com but not signed in. Log in, then come back and click Fetch.",
        actions: [['Sign in to X', 'https://x.com/i/flow/login']],
      },
    };
  }
  return { ok: true };
}

async function preflightRedNote() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://www.xiaohongshu.com/*',
      'https://xiaohongshu.com/*',
      'https://www.rednote.com/*',
      'https://rednote.com/*',
    ],
  });
  if (tabs.length === 0) {
    return {
      ok: false,
      warning: {
        title: 'Open RedNote first',
        body: 'The extension needs a rednote.com or xiaohongshu.com tab. Open one, sign in, then navigate to your profile page.',
        actions: [
          ['Open RedNote', 'https://www.rednote.com'],
          ['Open XiaoHongShu', 'https://www.xiaohongshu.com'],
        ],
      },
    };
  }
  // The profile URL contains the user_id — landing on it requires being
  // signed in, so this check covers "tab open + profile + logged in".
  const hasProfile = tabs.some((t) => /\/user\/profile\/[a-f0-9]+/.test(t.url || ''));
  if (!hasProfile) {
    return {
      ok: false,
      warning: {
        title: 'Open your RedNote profile first',
        body: "You have a RedNote tab open, but the extension needs your profile page (URL contains /user/profile/<id>). Tap your avatar to go there, then click Fetch again. If you're not signed in yet, sign in first.",
        actions: [
          ['Open RedNote', 'https://www.rednote.com'],
          ['Open XiaoHongShu', 'https://www.xiaohongshu.com'],
        ],
      },
    };
  }
  return { ok: true };
}

async function preflightYouTube() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.youtube.com/*', 'https://youtube.com/*', 'https://m.youtube.com/*'],
  });
  if (tabs.length === 0) {
    return {
      ok: false,
      warning: {
        title: 'Open YouTube first',
        body: 'The extension needs a youtube.com tab (signed in) to read your Watch Later. Open YouTube, sign in, then click Fetch again.',
        actions: [['Open YouTube', 'https://www.youtube.com/playlist?list=WL']],
      },
    };
  }
  // YouTube sets window.yt.config_.LOGGED_IN on every page. Undefined means
  // the page is still booting \u2014 optimistically allow and let the scrape
  // error surface; explicit false means a signed-out session.
  const loggedIn = await evalInTab(tabs[0].id, () => {
    try {
      const v = window.yt && window.yt.config_ && window.yt.config_.LOGGED_IN;
      if (typeof v === 'boolean') return v;
    } catch {}
    return null; // unknown
  });
  if (loggedIn === false) {
    return {
      ok: false,
      warning: {
        title: 'Sign in to YouTube',
        body: "You're on youtube.com but not signed in. Watch Later is private, so you need to log in first.",
        actions: [['Sign in to YouTube', 'https://accounts.google.com/ServiceLogin?service=youtube']],
      },
    };
  }
  return { ok: true };
}

async function evalInTab(tabId, func) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
    });
    return res?.result;
  } catch {
    return undefined;
  }
}

function showWarning({ title, body, actions }) {
  statusCard.hidden = false;
  statusCard.classList.remove('is-success', 'is-error');
  statusCard.classList.add('is-warning');

  statusText.textContent = title;
  statusMeta.textContent = '';
  statusSub.textContent = body;

  statusIcon.className = 'status-icon';
  statusIcon.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M8 2 L14.5 13.5 L1.5 13.5 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<path d="M8 6 V9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="8" cy="11.5" r="0.9" fill="currentColor"/>' +
    '</svg>';

  progressWrap.hidden = true;
  runAgainBtn.hidden = true;

  // Append/rebuild an action row with quick-open links. Reuse the node so
  // repeated pre-flight warnings don't stack.
  let actionsEl = document.getElementById('statusActions');
  if (!actionsEl) {
    actionsEl = document.createElement('div');
    actionsEl.id = 'statusActions';
    actionsEl.className = 'status-actions';
    statusCard.appendChild(actionsEl);
  }
  actionsEl.innerHTML = '';
  (actions || []).forEach(([label, url], i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-action-btn' + (i === 0 ? '' : ' secondary');
    btn.textContent = label;
    btn.addEventListener('click', () => chrome.tabs.create({ url }));
    actionsEl.appendChild(btn);
  });
}

runAgainBtn.addEventListener('click', () => fetchBtn.click());

function setRunning(on) {
  fetchBtn.disabled = on;
  fetchBtn.classList.toggle('is-loading', on);
  ctaLabel.textContent = on ? 'Fetching…' : 'Fetch & download JSON';
}

// -------------------------------------------------------------------------
// Status card
// -------------------------------------------------------------------------

function showStatus({ kind, text, meta, sub, current, total }) {
  statusCard.hidden = false;
  statusCard.classList.remove('is-warning');
  statusCard.classList.toggle('is-success', kind === 'success');
  statusCard.classList.toggle('is-error',   kind === 'error');
  // Drop the pre-flight action row if it's lingering from a previous warning.
  document.getElementById('statusActions')?.remove();

  statusText.textContent = text || '';
  statusMeta.textContent = meta || '';
  statusSub.textContent  = sub  || '';

  // Icon variant
  statusIcon.className = 'status-icon';
  if (kind === 'running') {
    statusIcon.classList.add('spinner');
    statusIcon.innerHTML = '';
  } else if (kind === 'success') {
    statusIcon.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  } else if (kind === 'error') {
    statusIcon.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 11l6-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  } else {
    statusIcon.innerHTML = '';
  }

  // Progress bar
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    progressWrap.hidden = false;
    const pct = Math.max(0, Math.min(100, (current / total) * 100));
    progressBar.style.width = pct + '%';
  } else if (kind !== 'running') {
    progressWrap.hidden = true;
    progressBar.style.width = '0%';
  }

  runAgainBtn.hidden = kind !== 'success' && kind !== 'error';
}

// -------------------------------------------------------------------------
// Service-worker messages
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    showStatus({
      kind: 'running',
      text: msg.text,
      meta: formatMeta(msg),
      current: msg.current,
      total: msg.total,
    });
  } else if (msg.type === 'done') {
    setRunning(false);
    if (msg.error) {
      showStatus({ kind: 'error', text: stripPrefix(msg.text, 'Error:'), sub: msg.sub || '' });
    } else {
      showStatus({
        kind: 'success',
        text: summarize(msg),
        sub: msg.filename || '',
      });
    }
  }
});

function formatMeta({ current, total }) {
  if (Number.isFinite(current) && Number.isFinite(total)) return `${current}/${total}`;
  return '';
}

function stripPrefix(s, prefix) {
  if (!s) return '';
  return s.startsWith(prefix) ? s.slice(prefix.length).trim() : s;
}

function summarize(msg) {
  if (msg.summary) return msg.summary;
  const match = msg.text?.match(/(\d+)/);
  return match ? `${match[1]} bookmarks exported` : 'Export complete';
}

// -------------------------------------------------------------------------
// Footer links
// -------------------------------------------------------------------------

document.querySelector('.foot').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  // These are placeholders for now — wire to real URLs/modals later.
  const target = a.dataset.link;
  const urls = {
    how:       'https://github.com/zephrimio/savesync-extension#readme',
    source:    'https://github.com/zephrimio/savesync-extension',
    changelog: 'https://github.com/zephrimio/savesync-extension/releases',
  };
  if (urls[target]) chrome.tabs.create({ url: urls[target] });
});

// -------------------------------------------------------------------------
// Restore state on popup reopen
// -------------------------------------------------------------------------

chrome.storage.session.get(['running', 'lastStatus']).then((s) => {
  if (s.running) setRunning(true);
  if (s.lastStatus) showStatus(s.lastStatus);
});
