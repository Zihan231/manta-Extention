/* ==========================================================================
   SITE ADAPTERS
   Each adapter tells the extension how to work with one directory site:
     id            - short key, used in the popup dropdown + job storage
     label         - shown in popup dropdown
     match(url)    - true if this adapter applies to the current page
     buildSearchUrl(term, location) - first-page URL for a keyword+location
     pagination    - { type: 'scroll' | 'click' | 'urlpage' | 'none', ...tuning }
                      'scroll'  - AJAX infinite scroll, same URL throughout
                      'click'   - real "Next" link that reloads the page
                      'urlpage' - next page = same URL with a page-number
                                  param changed (requires buildPageUrl)
     getNextLink(doc)  - (click type only) returns the <a> element to click
     buildPageUrl(term, location, pageNum) - (urlpage type only)
     extract(doc)  - returns array of row objects scraped from current DOM

   TO ADD A NEW SITE (e.g. TrueLocal.com.au, HomeStars.com):
   Copy one of the adapters below, change match()/buildSearchUrl(), and
   adjust extract() to that site's markup. Nothing else needs to change.
   ========================================================================== */

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function textLines(el) {
  return el.innerText.split('\n').map(s => s.trim()).filter(Boolean);
}

function findPhone(text) {
  const m = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return m ? m[0] : '';
}

function findEmail(text) {
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0] : '';
}

// Walk up from an anchor until we find a reasonable "card" container
// (one that also holds a phone number / tel link), capped at N levels.
function walkUpToCard(anchor, maxLevels) {
  let card = anchor;
  for (let i = 0; i < maxLevels && card.parentElement; i++) {
    card = card.parentElement;
    if (card.querySelector('a[href^="tel:"]') || /CLAIMED/i.test(card.textContent)) break;
  }
  return card;
}

// Manta's /search endpoint pages via a plain "pg=N" URL param, plus
// page_size=10 (without it Manta picks an inconsistent page window, which
// is what made pagination look like it "ran out" after ~7 rows).
//
// Real pagination links copied from manta.com (page 2+) also carry
// context=industry & search_source=nav - confirmed these are actually
// required for "pg" to be honored past the first page (omitting them made
// every subsequent page silently re-serve the same page's content, i.e.
// looked like it was "stuck" on one page forever). But sending them on the
// very first request (page 1, before Manta has resolved the term to an
// industry) 500s immediately - Manta's own search form doesn't send them
// either; only its rendered page-2+ links do. So: page 1 omits them,
// page 2+ includes them, matching what a real browser session does.
function buildMantaUrl(term, location, pageNum) {
  const parts = location.split(',').map(s => s.trim()).filter(Boolean);
  const city = parts[0] || '';
  const state = parts[1] || '';
  const country = parts[2] || '';
  const page = pageNum && pageNum > 1 ? pageNum : 1;
  const params = new URLSearchParams({
    search: term,
    city, state, country,
    page_size: '25', // NOTE: earlier testing showed Manta's backend not honoring this past page 1 (page 2 mostly re-served page 1) - watch for overlapping pages
    pg: String(page)
  });
  if (page > 1) {
    params.set('context', 'industry');
    params.set('search_source', 'nav');
  }
  return `https://www.manta.com/search?${params.toString()}`;
}

const MANTA = {
  id: 'manta',
  label: 'Manta.com',
  match: (url) => /(^|\.)manta\.com$/i.test(hostnameOf(url)),
  buildSearchUrl: (term, location) => buildMantaUrl(term, location, 1),
  buildPageUrl: buildMantaUrl,
  // Some Manta pages also lazy-load a bit within a page, so we settle-scroll
  // briefly before extracting, then move to the next pg= value.
  // maxPages is just a runaway-safety ceiling, not the expected page count.
  pagination: { type: 'urlpage', maxPages: 300, waitMs: 1400, settleScrolls: 2 },
  // Manta's search is ES-backed, and offset pagination on an unstable sort
  // can return a long stretch of overlapping/duplicate pages even while
  // more genuinely new results exist further on - so "did we extract any
  // new rows" is not a reliable stop signal here (confirmed: it cut a real
  // ~500+ result search short at page 53 while manta.com's own pagination
  // control still showed pages 54, 55... beyond that). Manta's own
  // pagination widget always links to pg=<current+1> when a further page
  // genuinely exists, so treat that as the authoritative signal instead.
  hasNextPage: (doc, currentPage) => {
    const nextPageRe = new RegExp('[?&]pg=' + (currentPage + 1) + '(&|$)');
    return Array.from(doc.querySelectorAll('a[href*="pg="]'))
      .some(a => nextPageRe.test(a.getAttribute('href') || ''));
  },
  extract: (doc) => {
    const anchors = Array.from(doc.querySelectorAll('a[href*="/c/"]'))
      .filter(a => /\/c\/[a-z0-9]+\//i.test(a.getAttribute('href') || ''));
    const seen = new Set();
    const rows = [];
    for (const a of anchors) {
      const href = a.href;
      const name = a.textContent.trim();
      if (!name || seen.has(href)) continue;
      seen.add(href);

      const card = walkUpToCard(a, 6);
      const text = card.textContent.replace(/\s+/g, ' ').trim();

      const telA = card.querySelector('a[href^="tel:"]');
      const phone = telA ? telA.getAttribute('href').replace('tel:', '') : findPhone(text);

      let website = '';
      const webA = card.querySelector('a[href*="urlverify?redirect="]');
      if (webA) {
        const m = (webA.getAttribute('href') || '').match(/redirect=([^&]+)/);
        website = m ? decodeURIComponent(m[1]) : '';
      }

      const catMatch = text.match(/Categorized under ([^.]+?)(?:\s{2}|$)/);
      const claimed = /UNCLAIMED/i.test(text) ? 'unclaimed' : (/\bCLAIMED\b/i.test(text) ? 'claimed' : '');

      // Best-effort address: line(s) right after the name, before phone/CLAIMED.
      const lines = textLines(card);
      const nameIdx = lines.findIndex(l => l === name);
      let address = '';
      if (nameIdx !== -1) {
        for (let i = nameIdx + 1; i < lines.length; i++) {
          const l = lines[i];
          if (/^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/.test(l)) break;
          if (/^(CLAIMED|UNCLAIMED)$/i.test(l)) break;
          if (/^Visit Website$/i.test(l)) continue;
          address += (address ? ', ' : '') + l;
          if (address.split(',').length >= 2) break;
        }
      }

      rows.push({
        name,
        address,
        phone,
        email: findEmail(text),
        website,
        category: catMatch ? catMatch[1].trim() : '',
        owner: '',
        claimed,
        sourceUrl: href
      });
    }
    return rows;
  }
};

// YellowPages already encodes the page number in the URL path itself
// (/search/si/<PAGE>/<term>/<location>) - so like Manta, this pages by
// direct URL increment. No DOM "Next" link to hunt for, nothing to click,
// nothing that can silently fail to be found after page 10.
function buildYellowpagesUrl(term, location, pageNum) {
  let base = 'www.yellowpages.ca';
  let loc = location;
  if (location.includes('|')) {
    const [domain, rest] = location.split('|');
    base = domain.trim();
    loc = rest.trim();
  }
  const slugTerm = encodeURIComponent(term).replace(/%20/g, '+');
  const slugLoc = encodeURIComponent(loc).replace(/%20/g, '+');
  return `https://${base}/search/si/${pageNum || 1}/${slugTerm}/${slugLoc}`;
}

const YELLOWPAGES = {
  id: 'yellowpages',
  label: 'YellowPages (.ca / .com / .com.au)',
  match: (url) => /yellowpages\.(ca|com|com\.au)$/i.test(hostnameOf(url)),
  // Defaults to yellowpages.ca. For .com or .com.au, prefix location with
  // the domain, e.g. location = "yellowpages.com.au|Sydney NSW".
  buildSearchUrl: (term, location) => buildYellowpagesUrl(term, location, 1),
  buildPageUrl: buildYellowpagesUrl,
  pagination: { type: 'urlpage', maxPages: 20, waitMs: 1600 },
  extract: (doc) => {
    const anchors = Array.from(doc.querySelectorAll('a[href*="/bus/"], a[href*="/biz/"]'))
      .filter(a => a.textContent.trim().length > 1);
    const seen = new Set();
    const rows = [];
    for (const a of anchors) {
      const href = a.href;
      const name = a.textContent.trim();
      if (!name || seen.has(href)) continue;
      seen.add(href);

      const card = walkUpToCard(a, 6);
      const text = card.textContent.replace(/\s+/g, ' ').trim();

      const telA = card.querySelector('a[href^="tel:"]');
      const phone = telA ? telA.getAttribute('href').replace('tel:', '') : findPhone(text);

      const webA = Array.from(card.querySelectorAll('a[href^="http"]'))
        .find(x => !/yellowpages\./i.test(x.href) && !/google\.com\/maps/i.test(x.href));
      const website = webA ? webA.href : '';

      rows.push({
        name,
        address: '',
        phone,
        email: findEmail(text),
        website,
        category: '',
        owner: '',
        claimed: '',
        sourceUrl: href
      });
    }
    return rows;
  }
};

// Fallback for any other directory site (TrueLocal, HomeStars, Hotfrog, etc).
// Grabs mailto: links, phone-looking text, and http(s) links near them.
// Loosest/noisiest adapter - use as a starting point, then copy+customize
// into a dedicated adapter once you've seen the real markup.
const GENERIC = {
  id: 'generic',
  label: 'Generic (any site, best-effort)',
  match: () => true,
  buildSearchUrl: (term, location) => {
    // No universal search URL - this adapter assumes the user has already
    // navigated to the right search-results page manually before starting.
    return window.location.href;
  },
  pagination: { type: 'click', maxPages: 6, waitMs: 1800 },
  getNextLink: (doc) => {
    const links = Array.from(doc.querySelectorAll('a'));
    return links.find(a => (a.textContent || '').trim().toLowerCase() === 'next') || null;
  },
  extract: (doc) => {
    const mailtos = Array.from(doc.querySelectorAll('a[href^="mailto:"]'));
    const rows = [];
    const seen = new Set();
    for (const m of mailtos) {
      const email = m.getAttribute('href').replace('mailto:', '').split('?')[0];
      const card = walkUpToCard(m, 6);
      const text = card.textContent.replace(/\s+/g, ' ').trim();
      const key = email + '|' + text.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        name: text.slice(0, 60),
        address: '',
        phone: findPhone(text),
        email,
        website: '',
        category: '',
        owner: '',
        claimed: '',
        sourceUrl: window.location.href
      });
    }
    return rows;
  }
};

globalThis.SITES = [MANTA, YELLOWPAGES, GENERIC];
