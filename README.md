# Local Biz Lead Scraper (Chrome Extension)

Scrapes business directory sites by keyword + location, auto-paginates, and
exports everything to CSV.

## Install (unpacked, for personal use)

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" -> select this folder
4. Pin the extension icon for easy access

## Use

1. Click the extension icon — this opens a single, persistent panel window
   (not the ephemeral little popup extensions normally show, and not a
   browser tab). It only closes when you close it — clicking the page,
   switching tabs, or clicking elsewhere no longer dismisses it.
2. Pick a site (Manta.com and YellowPages are pre-built; "Generic" works on
   any page you're already viewing)
3. Enter search terms — one per line, or comma-separated (e.g.
   `restaurants, dental, plumbers`)
4. Enter one or more locations, **one per line** (e.g.
   `Toronto, ON, Canada` then `Vancouver, BC, Canada` on the next line) —
   every term runs in every location, one city's terms finishing before the
   next city starts
5. Click Start.

That same window updates the instant new data arrives (via
`chrome.storage.onChanged`, no polling delay): status pill, current
term/location/page, a progress bar across the whole term×location queue,
running row count, and a live feed of the most recent leads. Clicking the
extension icon again focuses this same window instead of opening a second
one. While a job is running or paused, the search form is disabled (grey)
so you can't accidentally overwrite it - Stop first to start a new one.

Click "Export CSV" any time — exports whatever's been collected so far,
even mid-run. "Stop" halts the crawl entirely.

### CAPTCHA / bot-check handling

Manta (and most directory sites) can throw a CAPTCHA or "unusual traffic"
interstitial at automated traffic, especially several pages into a run.
When that's detected, the job automatically switches to **Paused** — a
banner appears on the dashboard explaining why, the tab is left exactly
as-is (nothing gets clicked or navigated away), and no progress is lost.
Solve the CAPTCHA yourself in that tab, then click **Continue** — the
extension resumes from the exact same page rather than restarting the
term or the whole run.

This also covers unexpected extraction errors generally: if a page's
markup doesn't match what an adapter expects, the job pauses with the
error message shown, instead of silently hanging forever in "running"
with the dashboard never updating again (which is what happened before
this was added).

CSV columns: `searchTerm, site, location, name, category, phone, email,
website, owner, claimed, address, sourceUrl`

## How site support works (`sites.js`)

Each directory is an "adapter" object with:
- `buildSearchUrl(term, location)` — first-page URL for a keyword
- `pagination` — `{ type: 'scroll' }` for infinite-scroll (AJAX) sites,
  `{ type: 'urlpage', maxPages }` for sites where the next page is the same
  URL with a page-number param changed (Manta uses `pg=N` — confirmed from
  Manta's own scraper metadata, so navigation is direct, no button-hunting),
  or `{ type: 'click', maxPages }` for sites with a real "Next" link that
  reloads the page (YellowPages)
- `extract(doc)` — pulls rows out of the current DOM

Extraction is written to be resilient to CSS-class changes: it locks onto
**stable URL patterns** (e.g. Manta's `/c/<id>/` business-detail links,
YellowPages' `/bus/` links) rather than guessed class names, then reads
phone/email/website out of the surrounding text with regex. This is more
durable than a hard-coded selector list, but directory sites do change
their markup — if a field comes back empty, that's the first thing to
check.

### Adding a new site (TrueLocal, HomeStars, Hotfrog, etc.)

Copy the `YELLOWPAGES` block in `sites.js`, then adjust:
1. `match()` — hostname check
2. `buildSearchUrl()` — that site's search URL format
3. `pagination.type` — `'scroll'` or `'click'` (open the site, search
   something, and see whether new results load via scroll or a Next
   button)
4. `extract()` — the href pattern their business-detail links use is
   usually the fastest stable anchor to key off of

No changes needed anywhere else — `content.js`/`background.js` just loop
over whatever's in the `SITES` array.

## Known limitations

- **Email/owner name are rarely on the search-results page itself** for
  Manta and YellowPages — those directories mostly gate that behind the
  individual business's detail page (or a paid/claimed listing). This tool
  scrapes list pages only, so `email`/`owner` will often be blank. A
  follow-up "deep enrichment" pass that visits each `sourceUrl` and
  re-extracts would fill these in — ask if you want that built.
- **Generic adapter** only scrapes whatever page is currently open; it
  can't build a search URL for a site it doesn't know, so multi-term runs
  aren't supported there — it grabs one page/term and stops.
- **Rate limiting**: default delays (1.2–1.8s between actions) are
  deliberately conservative to avoid tripping bot detection. Lower them in
  `sites.js` (`waitMs`/`maxRounds`/`maxPages`) at your own risk.
- Directory sites' markup changes over time — if extraction breaks, it's
  almost always a 5-minute fix in that one adapter's `extract()`, not a
  rewrite.
