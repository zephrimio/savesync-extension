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

fetchBtn.addEventListener('click', () => {
  setRunning(true);
  showStatus({ kind: 'running', text: `Starting ${PLATFORM_NAMES[selectedPlatform]}…` });
  chrome.runtime.sendMessage({
    type: 'fetch',
    platform: selectedPlatform,
    count: selectedCount,
  });
});

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
  statusCard.classList.toggle('is-success', kind === 'success');
  statusCard.classList.toggle('is-error',   kind === 'error');

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
