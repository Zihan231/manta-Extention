(function () {
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getJob() {
    return new Promise(resolve => chrome.storage.local.get('job', d => resolve(d.job)));
  }
  function setJob(job) {
    return new Promise(resolve => chrome.storage.local.set({ job }, resolve));
  }

  function getAdapter() {
    return (globalThis.SITES || []).find(s => {
      try { return s.match(location.href); } catch (e) { return false; }
    });
  }

  function dedupeMerge(a, b) {
    const seen = new Set(a.map(r => r.sourceUrl));
    return a.concat(b.filter(r => !seen.has(r.sourceUrl)));
  }

  // Bot-check / CAPTCHA interstitials don't have the DOM structure any
  // adapter expects, which previously caused extract() to throw and kill
  // this script silently mid-page - the job would sit in "running" forever
  // with nothing left to report. Checking for this explicitly, up front,
  // turns that freeze into a clear "paused - solve it yourself" state.
  function looksLikeCaptcha(doc) {
    const text = (doc.body ? doc.body.innerText : '').toLowerCase().slice(0, 4000);
    const markers = [
      'captcha', 'verify you are human', 'unusual traffic', 'are you a robot',
      'checking your browser', 'security check', 'access denied', 'blocked'
    ];
    if (markers.some(m => text.includes(m))) return true;
    if (doc.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], #challenge-form, .g-recaptcha, #cf-challenge')) return true;
    return false;
  }

  function pause(reason) {
    chrome.runtime.sendMessage({ type: 'PAUSE', reason });
  }

  async function settleScroll(rounds, waitMs) {
    for (let i = 0; i < rounds; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await delay(waitMs);
    }
  }

  async function scrollAndCollect(adapter, term, location_) {
    let lastCount = 0;
    let stableRounds = 0;
    const maxRounds = (adapter.pagination && adapter.pagination.maxRounds) || 6;
    const waitMs = (adapter.pagination && adapter.pagination.waitMs) || 1500;

    for (let i = 0; i < maxRounds; i++) {
      const job = await getJob();
      if (!job || job.status !== 'running') break;

      window.scrollTo(0, document.body.scrollHeight);
      await delay(waitMs);

      const rows = adapter.extract(document);
      chrome.runtime.sendMessage({ type: 'PROGRESS', term, location: location_, rows });

      if (rows.length <= lastCount) {
        stableRounds++;
        if (stableRounds >= 2) break;
      } else {
        stableRounds = 0;
      }
      lastCount = rows.length;
    }
    return adapter.extract(document);
  }

  async function handleClickPagination(adapter, job, term, location_) {
    await delay(700);
    const currentRows = adapter.extract(document);
    const accum = dedupeMerge(job.pageAccum || [], currentRows);
    chrome.runtime.sendMessage({ type: 'PROGRESS', term, location: location_, rows: accum });

    const maxPages = (adapter.pagination && adapter.pagination.maxPages) || 8;
    const waitMs = (adapter.pagination && adapter.pagination.waitMs) || 1800;
    const pageNum = job.pageNum || 1;

    const next = adapter.getNextLink ? adapter.getNextLink(document) : null;

    if (!next || pageNum >= maxPages) {
      chrome.runtime.sendMessage({ type: 'TERM_DONE', term, location: location_, rows: accum });
      return;
    }

    job.pageAccum = accum;
    job.pageNum = pageNum + 1;
    await setJob(job);
    await delay(waitMs);
    next.click();
  }

  // NOTE: this function must never write `job` to chrome.storage itself.
  // It used to (setJob(job) below), racing against background.js's own
  // serial read-modify-write of the same key for the PROGRESS message this
  // function had just fired - whichever write landed second clobbered the
  // other's pageNum/pageAccum, which surfaced as pagination stalling and
  // re-requesting the same page over and over instead of advancing. Now
  // background.js is the only writer: it owns pageNum/pageAccum for this
  // path and does the navigation once its write has committed.
  async function handleUrlPagePagination(adapter, job, term, location_) {
    const settleRounds = (adapter.pagination && adapter.pagination.settleScrolls) || 0;
    const waitMs = (adapter.pagination && adapter.pagination.waitMs) || 1400;
    if (settleRounds > 0) await settleScroll(settleRounds, waitMs);
    else await delay(waitMs);

    const currentRows = adapter.extract(document);
    const before = (job.pageAccum || []).length;
    const accum = dedupeMerge(job.pageAccum || [], currentRows);
    const addedThisPage = accum.length - before;

    const maxPages = (adapter.pagination && adapter.pagination.maxPages) || 10;
    const pageNum = job.pageNum || 1;

    let reachedEnd;
    let staleStreak = 0;
    if (adapter.hasNextPage) {
      // Trust the site's own pagination control over our row-count
      // heuristic - see sites.js for why the heuristic alone is unreliable
      // on Manta.
      reachedEnd = !adapter.hasNextPage(document, pageNum) || pageNum >= maxPages;
    } else {
      // Fallback for adapters with no hasNextPage: require a short streak
      // of consecutive zero-new-rows pages (mirrors the stableRounds check
      // scrollAndCollect uses for infinite-scroll sites) before concluding
      // we're actually done, since a single such page isn't always the end.
      const maxStaleStreak = (adapter.pagination && adapter.pagination.maxStaleStreak) || 3;
      staleStreak = pageNum > 1
        ? (addedThisPage === 0 ? (job.staleStreak || 0) + 1 : 0)
        : 0;
      reachedEnd = staleStreak >= maxStaleStreak || pageNum >= maxPages;
    }

    if (reachedEnd) {
      chrome.runtime.sendMessage({ type: 'TERM_DONE', term, location: location_, rows: accum });
    } else {
      chrome.runtime.sendMessage({ type: 'NEXT_PAGE', term, location: location_, rows: accum, pageNum, staleStreak });
    }
  }

  async function attemptRun() {
    const job = await getJob();
    if (!job || job.status !== 'running') return;

    const adapter = getAdapter();
    if (!adapter) return;

    if (window.__leadScraperRanFor === location.href) return;
    window.__leadScraperRanFor = location.href;

    const pair = job.queue[job.queueIndex];
    if (!pair) return;
    const { term, location: loc } = pair;

    await delay(1200); // let the page finish its own initial render

    if (looksLikeCaptcha(document)) {
      pause('CAPTCHA / bot-check detected on ' + location.hostname + '. Solve it in this tab, then click Continue.');
      return;
    }

    const type = adapter.pagination && adapter.pagination.type;

    try {
      if (type === 'scroll') {
        const rows = await scrollAndCollect(adapter, term, loc);
        chrome.runtime.sendMessage({ type: 'TERM_DONE', term, location: loc, rows });
      } else if (type === 'click') {
        await handleClickPagination(adapter, job, term, loc);
      } else if (type === 'urlpage') {
        await handleUrlPagePagination(adapter, job, term, loc);
      } else {
        const rows = adapter.extract(document);
        chrome.runtime.sendMessage({ type: 'PROGRESS', term, location: loc, rows });
        chrome.runtime.sendMessage({ type: 'TERM_DONE', term, location: loc, rows });
      }
    } catch (err) {
      // Whatever went wrong (unexpected markup, a mid-run interstitial this
      // heuristic didn't catch, etc.) - pause with the real reason instead
      // of dying silently and leaving the job stuck in "running" forever.
      pause('Extraction error: ' + (err && err.message ? err.message : String(err)));
    }
  }

  // Lets the "Continue" button (via background.js -> RESUME -> this tab)
  // retry the current page without a fresh navigation.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RETRY_PAGE') {
      window.__leadScraperRanFor = null;
      attemptRun();
    }
  });

  attemptRun();
})();
