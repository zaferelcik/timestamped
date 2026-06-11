# Timestamped

**Find when a web page was actually published.**

Timestamped is a Chrome extension that detects the likely publication date of
the page you're reading — from its metadata, structured data, time tags, URL
patterns, and the Wayback Machine — and surfaces the last-modified date too.

[Install](#installation) · [How it works](#how-it-works) · [Privacy](#privacy)

---

## Why

Modern sites are bad at telling you when something was published. Dates get
hidden, replaced with "updated" timestamps, or omitted entirely — which makes
it hard to judge whether an article is fresh or years old. Timestamped reads
every date signal a page exposes, ranks them, and shows you the most likely
**publication** date along with a confidence level. When a page only advertises
an "updated" date, it's shown separately so a refreshed article never looks
like it was published today.

## Features

- **Multiple detection sources** — `<meta>` tags (`article:published_time`,
  schema.org `datePublished`, Dublin Core, and more), JSON-LD structured data,
  `<time>` elements, date patterns in the URL (`/2021/11/13/`), and visible
  "Published on…" text.
- **Publish vs. modified** — modification signals (`article:modified_time`,
  `dateModified`, "Updated/Güncelleme") are captured but can never be mistaken
  for the publish date; they appear in a separate **Last modified** line.
- **English + Turkish** — month names and date labels are recognised in both
  languages.
- **Wayback Machine fallback** — if the page itself gives no strong date, the
  first archived snapshot is used as an upper bound.
- **Confidence meter** — every result comes with a 0–100% score and a plain
  explanation of where it came from.
- **All signals view** — an expandable list of every date found, with scores,
  for full transparency.
- **Fast and resilient** — strong on-page dates render instantly without any
  network call; everything else is timeout-bounded, so the popup never hangs.
  Results are cached for 12 hours.
- **Copy** — one click copies the result to your clipboard.

## Installation

Timestamped isn't on the Chrome Web Store yet. To run it locally:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. Pin the deer icon to your toolbar, then click it on any article.

> Works on Chrome 114+ and other Chromium-based browsers (Edge, Brave, etc.).

## How it works

When you click the toolbar icon, Timestamped runs a small scraper in the active
tab and collects every date signal it can find. Each candidate is parsed,
sanity-checked (no dates before 1990 or in the future), and scored. The
pipeline is:

1. **Scan the page** — metadata, JSON-LD, `<time>` tags, the canonical URL, and
   visible date labels.
2. **Score candidates** — publish-date signals rank highest; modified/updated
   signals are capped so they can't win the publish slot. Near-ties are broken
   toward the *earliest* date, which is closest to the true first-publication
   moment.
3. **Skip the network when possible** — if the page already provided a
   high-confidence date (≥ 85%), no external request is made.
4. **Fall back to the Wayback Machine** — otherwise, the first archived snapshot
   is fetched (with a timeout, and a CDX → availability-API fallback) as an
   upper bound.
5. **Render** — the best publish date, an optional last-modified line, a
   confidence meter, and the full signal list.

## Privacy

Timestamped is designed to read as little as possible and send nothing about
you anywhere.

- Permissions are minimal: `activeTab` and `scripting` (the page is only
  inspected when you click the icon — there's no background content script on
  every site), and `storage` for the local 12-hour result cache.
- The only outbound network request is to the Internet Archive
  (`web.archive.org` / `archive.org`), and only when the page itself doesn't
  provide a confident date. That request contains the page URL so the archive
  can look it up — nothing else.
- No analytics, no tracking, no accounts, no third-party servers.

## Project structure

```
timestamped/
├── manifest.json     # Manifest V3 configuration
├── popup.html        # Popup markup
├── popup.css         # Styles (#105AB6 palette)
├── popup.js          # Detection, scoring, Wayback, rendering
├── icons/            # Toolbar + store icons
└── docs/             # README assets
```

## Development

There's no build step — it's plain HTML, CSS, and JavaScript with zero
dependencies. Edit the files, then reload the extension from
`chrome://extensions` to see your changes.

## License

Released under the [MIT License](LICENSE).

## Acknowledgements

Inspired by the long-discontinued *Finitimus* publish-date add-on, rebuilt from
scratch on Manifest V3 with no external frameworks.
