const statusEl = document.getElementById('status');

function parseLines(raw) {
  return raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

async function openOrFocusDashboard() {
  const stored = await new Promise(r => chrome.storage.local.get('dashboardWindowId', d => r(d.dashboardWindowId)));
  if (stored) {
    try {
      await chrome.windows.update(stored, { focused: true });
      return;
    } catch (e) {
      // window no longer exists, fall through and create a new one
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('dashboard.html'),
    type: 'popup',
    width: 460,
    height: 680
  });
  chrome.storage.local.set({ dashboardWindowId: win.id });
}

document.getElementById('start').addEventListener('click', async () => {
  const site = document.getElementById('site').value;
  const terms = parseLines(document.getElementById('terms').value);
  const locationLines = document.getElementById('locations').value.split('\n').map(s => s.trim()).filter(Boolean);

  if (terms.length === 0) {
    statusEl.textContent = 'Enter at least one search term.';
    return;
  }
  if (site !== 'generic' && locationLines.length === 0) {
    statusEl.textContent = 'Enter at least one location.';
    return;
  }

  const locations = site === 'generic' ? [''] : locationLines;

  // Cross product: every term run in every location, location-outer so
  // one city's terms all finish before moving to the next city.
  const combinedQueue = [];
  for (const loc of locations) {
    for (const term of terms) {
      combinedQueue.push({ term, location: loc });
    }
  }

  chrome.runtime.sendMessage({ type: 'START', site, queue: combinedQueue });
  await openOrFocusDashboard();
  window.close();
});

document.getElementById('dashboard').addEventListener('click', openOrFocusDashboard);

document.getElementById('clear').addEventListener('click', async () => {
  await new Promise(r => chrome.storage.local.set({ job: null }, r));
  statusEl.textContent = 'Cleared.';
});
