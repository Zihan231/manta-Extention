function getJob() {
  return new Promise(resolve => chrome.storage.local.get('job', d => resolve(d.job)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
}

const ICONS = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
};

function render(job) {
  const badge = document.getElementById('badge');
  const badgeText = document.getElementById('badgeText');
  const meta = document.getElementById('meta');
  const term = document.getElementById('term');
  const locationEl = document.getElementById('location');
  const page = document.getElementById('page');
  const count = document.getElementById('count');
  const rowsEl = document.getElementById('rows');
  const fill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');
  const banner = document.getElementById('pauseBanner');
  const pauseReason = document.getElementById('pauseReason');
  const configSection = document.getElementById('configSection');
  const startBtn = document.getElementById('start');
  const startHint = document.getElementById('startHint');
  const stopBtn = document.getElementById('stop');

  const busy = !!job && (job.status === 'running' || job.status === 'paused');
  configSection.classList.toggle('busy', busy);
  startBtn.disabled = busy;
  startHint.textContent = busy ? 'A search is already running - Stop it to start a new one.' : '';
  // Stop only ever does anything to a running job - keep it disabled the
  // rest of the time so it's obvious clicking it did something (and can't
  // be clicked again while the STOP message is still in flight).
  stopBtn.disabled = !job || job.status !== 'running';

  if (!job) {
    badge.className = 'pill idle';
    badgeText.textContent = 'idle';
    meta.textContent = 'No job running - start one from the extension popup.';
    term.textContent = '-';
    locationEl.textContent = '-';
    page.textContent = '-';
    count.textContent = '0';
    rowsEl.innerHTML = '<div class="empty">Nothing collected yet.</div>';
    fill.style.width = '0%';
    progressLabel.textContent = '0 of 0 pairs complete';
    banner.classList.remove('show');
    return;
  }

  badge.className = 'pill ' + job.status;
  badgeText.textContent = job.status;
  if (job.status === 'stopped') {
    meta.textContent = `Stopped - ${job.results.length} lead${job.results.length === 1 ? '' : 's'} collected before stopping. Export below, or Start a new search.`;
  } else if (job.status === 'done') {
    meta.textContent = `Finished - ${job.results.length} lead${job.results.length === 1 ? '' : 's'} collected. Export below, or Start a new search.`;
  } else {
    meta.textContent = `${job.site}`;
  }

  const pair = job.queue[job.queueIndex] || { term: 'finished', location: '' };
  term.textContent = `${Math.min(job.queueIndex + 1, job.queue.length)}/${job.queue.length} · ${pair.term}`;
  locationEl.textContent = pair.location || '-';
  page.textContent = job.pageNum || 1;
  count.textContent = job.results.length;

  const donePairs = job.status === 'done' ? job.queue.length : job.queueIndex;
  const pct = job.queue.length ? Math.round((donePairs / job.queue.length) * 100) : 0;
  fill.style.width = pct + '%';
  progressLabel.textContent = `${donePairs} of ${job.queue.length} pairs complete`;

  if (job.status === 'paused') {
    banner.classList.add('show');
    pauseReason.textContent = job.pausedReason || 'Paused - check the tab.';
  } else {
    banner.classList.remove('show');
  }

  if (job.results.length === 0) {
    rowsEl.innerHTML = '<div class="empty">Nothing collected yet.</div>';
    return;
  }

  const multiLoc = new Set(job.queue.map(q => q.location)).size > 1;
  const recent = job.results.slice().reverse().slice(0, 200);
  rowsEl.innerHTML = recent.map(r => {
    const chips = [];
    if (r.phone) chips.push(`<span class="chip">${ICONS.phone}${escapeHtml(r.phone)}</span>`);
    if (r.email) chips.push(`<span class="chip">${ICONS.mail}${escapeHtml(r.email)}</span>`);
    if (r.address) chips.push(`<span class="chip">${ICONS.pin}${escapeHtml(r.address)}</span>`);
    if (r.website) chips.push(`<span class="chip">${ICONS.link}${escapeHtml(hostnameOf(r.website))}</span>`);
    if (r.sourceUrl) chips.push(`<a class="chip link" href="${r.sourceUrl}" target="_blank" rel="noopener">Open listing</a>`);
    const locTag = multiLoc && r.location ? `<span class="loc-tag">${escapeHtml(r.location)}</span>` : '';
    return `
      <div class="rowitem">
        <div class="top">
          <span class="name">${escapeHtml(r.name || '(no name)')}</span>
          <span class="tag-group">${locTag}<span class="term-tag">${escapeHtml(r.searchTerm)}</span></span>
        </div>
        <div class="chips">${chips.join('')}</div>
      </div>`;
  }).join('');
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Builds a "list of single-line inputs + Add more button" control (used for
// both search terms and locations instead of a multi-line textarea, so each
// entry is its own clearly separate field).
function makeDynList(containerId, addBtnId, placeholder) {
  const container = document.getElementById(containerId);
  const addBtn = document.getElementById(addBtnId);

  function addRow(value) {
    const row = document.createElement('div');
    row.className = 'dyn-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    if (value) input.value = value;
    row.appendChild(input);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'dyn-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      if (container.children.length > 1) row.remove();
      else input.value = '';
    });
    row.appendChild(removeBtn);

    container.appendChild(row);
    return input;
  }

  addBtn.addEventListener('click', () => addRow('').focus());
  addRow(''); // always start with one row

  return {
    // splitCommas: also split each field on commas (useful for terms -
    // pasting "restaurants, dental, plumbers" into one box still works -
    // but not for locations, where a comma is part of "City, State").
    getValues(splitCommas) {
      return Array.from(container.querySelectorAll('input'))
        .map(i => i.value.trim())
        .filter(Boolean)
        .flatMap(v => splitCommas ? v.split(',').map(s => s.trim()).filter(Boolean) : [v]);
    }
  };
}

const termsList = makeDynList('termsList', 'addTerm', 'e.g. Roofing contractor');
const locationsList = makeDynList('locationsList', 'addLocation', 'e.g. South San Francisco, CA');

document.getElementById('start').addEventListener('click', async () => {
  const startHint = document.getElementById('startHint');
  const site = document.getElementById('site').value;
  const terms = termsList.getValues(true);
  const locationLines = locationsList.getValues(false);

  if (terms.length === 0) {
    startHint.textContent = 'Enter at least one search term.';
    return;
  }
  if (site !== 'generic' && locationLines.length === 0) {
    startHint.textContent = 'Enter at least one location.';
    return;
  }

  const locations = site === 'generic' ? [''] : locationLines;
  const combinedQueue = [];
  for (const loc of locations) {
    for (const term of terms) combinedQueue.push({ term, location: loc });
  }

  startHint.textContent = '';
  chrome.runtime.sendMessage({ type: 'START', site, queue: combinedQueue });
});

document.getElementById('stop').addEventListener('click', (e) => {
  // Disable immediately for instant feedback - render() will keep it
  // disabled once job.status confirms the stop (or re-enable it if
  // something went wrong and the job is still running).
  e.currentTarget.disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP' });
});

document.getElementById('resume').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESUME' });
});

document.getElementById('export').addEventListener('click', async () => {
  const job = await getJob();
  if (!job || !job.results || job.results.length === 0) return;

  const cols = ['searchTerm', 'location', 'site', 'name', 'category', 'phone', 'email', 'website', 'owner', 'claimed', 'address', 'sourceUrl'];
  const escape = (v) => {
    const s = (v === undefined || v === null) ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvLines = [cols.join(',')];
  for (const row of job.results) csvLines.push(cols.map(c => escape(row[c])).join(','));
  const csv = csvLines.join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const terms = [...new Set(job.queue.map(q => q.term))].map(slugify).filter(Boolean);
  const locations = [...new Set(job.queue.map(q => q.location))].map(slugify).filter(Boolean);
  const stamp = new Date().toISOString().slice(0, 10);
  let filename = [job.site, ...terms, ...locations, stamp].filter(Boolean).join('_');
  if (filename.length > 150) filename = filename.slice(0, 150);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.job) render(changes.job.newValue);
});

getJob().then(render);
