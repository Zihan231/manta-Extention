importScripts('sites.js');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJob() {
  return new Promise(resolve => chrome.storage.local.get('job', d => resolve(d.job)));
}
function setJob(job) {
  return new Promise(resolve => chrome.storage.local.set({ job }, resolve));
}
function findAdapterById(id) {
  return (globalThis.SITES || []).find(s => s.id === id);
}

async function openOrFocusPanel() {
  const stored = await new Promise(r => chrome.storage.local.get('panelWindowId', d => r(d.panelWindowId)));
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
    height: 700
  });
  chrome.storage.local.set({ panelWindowId: win.id });
}

// No default_popup in the manifest, so clicking the toolbar icon fires
// this instead of opening (and instantly risking closing) an ephemeral
// action-popup. This window is a real, separate OS window - it only
// closes when the user closes it.
chrome.action.onClicked.addListener(() => { openOrFocusPanel(); });

// chrome.storage.get/set are NOT atomic - every handler below is funneled
// through this single chain so read-modify-write cycles never overlap
// (two near-simultaneous messages clobbering each other was the earlier
// "rows stuck at 0" bug).
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn, (err) => { console.error(err); });
  return queue;
}

function mergeIntoResults(job, term, location, rows) {
  const seen = new Set(job.results.map(r => r.sourceUrl));
  const tagged = rows
    .filter(r => !seen.has(r.sourceUrl))
    .map(r => ({ searchTerm: term, location, site: job.site, ...r }));
  job.results = job.results.concat(tagged);
}

async function navigateToPair(job) {
  const adapter = findAdapterById(job.site);
  if (adapter.id === 'generic') return; // scrapes whatever tab is already open
  const pair = job.queue[job.queueIndex];
  const url = adapter.buildSearchUrl(pair.term, pair.location);
  await chrome.tabs.update(job.tabId, { url });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START') {
    serial(async () => {
      const adapter = findAdapterById(msg.site);
      if (!adapter) return;

      let tabId;
      if (adapter.id === 'generic') {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) return;
        tabId = activeTab.id;
      } else {
        const first = msg.queue[0];
        const url = adapter.buildSearchUrl(first.term, first.location);
        const tab = await chrome.tabs.create({ url });
        tabId = tab.id;
      }

      const job = {
        status: 'running',
        site: msg.site,
        queue: msg.queue,          // [{ term, location }, ...]
        queueIndex: 0,
        tabId,
        results: [],
        pageAccum: [],
        pageNum: 1,
        staleStreak: 0,
        pausedReason: null
      };
      await setJob(job);
    });
  }

  if (msg.type === 'STOP') {
    serial(async () => {
      const job = await getJob();
      if (job) {
        job.status = 'stopped';
        await setJob(job);
      }
    });
  }

  // Content script hit a CAPTCHA / bot-check, or an extraction error, and
  // is intentionally NOT touching pageAccum/pageNum - so resuming continues
  // from exactly the same page instead of losing progress or restarting.
  if (msg.type === 'PAUSE') {
    serial(async () => {
      const job = await getJob();
      if (!job || job.status !== 'running') return;
      job.status = 'paused';
      job.pausedReason = msg.reason || 'Paused.';
      await setJob(job);
    });
  }

  // User solved the CAPTCHA (or just wants to retry) - tell the content
  // script on that specific tab to re-attempt the current page.
  if (msg.type === 'RESUME') {
    serial(async () => {
      const job = await getJob();
      if (!job || job.status !== 'paused') return;
      job.status = 'running';
      job.pausedReason = null;
      await setJob(job);
      try {
        await chrome.tabs.sendMessage(job.tabId, { type: 'RETRY_PAGE' });
      } catch (e) {
        // Tab may have been closed/navigated away manually - nothing to nudge.
      }
    });
  }

  // Fired after every page so the dashboard's row count climbs live
  // instead of jumping once at the end of each term/location pair.
  if (msg.type === 'PROGRESS') {
    serial(async () => {
      const job = await getJob();
      if (!job || job.status !== 'running') return;
      mergeIntoResults(job, msg.term, msg.location, msg.rows);
      await setJob(job);
    });
  }

  // urlpage-type adapters (Manta, YellowPages) send this after each page
  // instead of writing pageNum/pageAccum themselves - this handler is the
  // only writer of those fields, inside the same serial queue as every
  // other job mutation, so it can't race with the PROGRESS-style merge
  // below and clobber the page-advance (that race was why pagination used
  // to stall/re-request the same page instead of moving forward).
  if (msg.type === 'NEXT_PAGE') {
    serial(async () => {
      const job = await getJob();
      if (!job || job.status !== 'running') return;

      mergeIntoResults(job, msg.term, msg.location, msg.rows);
      job.pageAccum = msg.rows;
      job.pageNum = msg.pageNum + 1;
      job.staleStreak = msg.staleStreak || 0;
      await setJob(job);

      const adapter = findAdapterById(job.site);
      const waitMs = (adapter.pagination && adapter.pagination.waitMs) || 1400;
      await delay(waitMs);
      const nextUrl = adapter.buildPageUrl(msg.term, msg.location, job.pageNum);
      try {
        await chrome.tabs.update(job.tabId, { url: nextUrl });
      } catch (e) {
        // Tab may have been closed manually - nothing to page forward.
      }
    });
  }

  if (msg.type === 'TERM_DONE') {
    serial(async () => {
      const job = await getJob();
      if (!job || job.status !== 'running') return;

      mergeIntoResults(job, msg.term, msg.location, msg.rows);
      job.queueIndex += 1;
      job.pageAccum = [];
      job.pageNum = 1;
      job.staleStreak = 0;

      if (job.queueIndex >= job.queue.length || findAdapterById(job.site).id === 'generic') {
        job.status = 'done';
        await setJob(job);
      } else {
        await setJob(job);
        await delay(1200);
        await navigateToPair(job);
      }
    });
  }
});
