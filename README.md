# bib-check

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-live%20demo-blue)](https://chenyuheee.github.io/bib-check/)
[![Python](https://img.shields.io/badge/python-3.10%2B-0B63D8)](https://www.python.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**Audit BibTeX bibliographies against authoritative metadata sources and rewrite entries to a clean, unified academic style.**

Paste a `.bib` file — bib-check queries OpenAlex, Crossref, Semantic Scholar, DBLP (and optionally Google Scholar), flags missing fields / `et al.` truncation / abbreviated venues / preprint-only refs, then emits a corrected bibliography.

---

## Quick start

```bash
pip install -e .
playwright install chromium          # only needed for --use-scholar
bib-check list mybib.bib | head      # find the slice you want
bib-check audit mybib.bib --range 1-50
```

Or use the **browser version** — zero install, runs entirely in your browser:

> [chenyuheee.github.io/bib-check](https://chenyuheee.github.io/bib-check/)

---

## Standard enforced

Every rewritten entry aims to satisfy:

1. **All authors listed** — no `et al.` / `and others` / truncation.
2. **Required fields**: `author`, `title`, `year`, plus venue (`booktitle` for conferences, `journal` for articles).
   - Conference names in **full** (no abbreviations like *Proc. NeurIPS*).
   - Journal articles must include `volume`, `number`, `pages`.
   - Stripped: `doi`, `url`, `eprint`, `eprinttype`, `biburl`, `bibsource`, `timestamp`.
3. **Prefer the published version** — if a paper has a peer-reviewed venue, that one wins over arXiv/CoRR.

---

## How it works

### Metadata lookup pipeline (first hit wins)

| Source | Description |
|--------|-------------|
| **OpenAlex** | Primary. Free REST API, ~250M works. Resolves arXiv preprints to published versions. |
| **Crossref** | Authoritative DOI metadata for journals and proceedings. Catches what OpenAlex misses. |
| **Semantic Scholar** | Tertiary. Broader coverage, especially recent papers. |
| **DBLP** | CS-specific. Excellent venue acronym → full name expansion. |
| **Google Scholar** | Opt-in (`--use-scholar`). Drives Chromium via Playwright to click Cite → BibTeX. Persistent browser profile so CAPTCHA solves survive across runs. |

All results are **cached on disk** by query hash — re-runs never re-hit the same source.

### Entry processing

```
.bib file → parse → detect issues → lookup metadata → rewrite → report + suggested.bib
```

- **Parser**: Hand-rolled, brace-depth-aware. Skips `@string`/`@preamble`/`@comment`.
- **Issue detector**: Flags missing fields, `et al.`, abbreviated venues, arXiv-only refs, unbalanced braces, future years, duplicate entries.
- **Rewriter**: Merge-only strategy — never overwrites existing fields unless the original is missing or clearly a preprint. Author lists keep the original ordering. Venue acronyms expanded from a hardcoded dictionary of 40+ CS conferences.

---

## Usage

```bash
# List entries (1-indexed positions, skips @string/@preamble/@comment)
bib-check list path/to/main.bib | head -20

# Audit a slice
bib-check audit path/to/main.bib --range 77-117

# Audit specific cite keys
bib-check audit path/to/main.bib --keys kriuk2025qkvcomm,liu2024droidspeak

# Local checks only (no network calls)
bib-check audit path/to/main.bib --range 1-50 --skip-openalex --skip-crossref --skip-dblp

# With Google Scholar fallback (headless browser)
bib-check audit path/to/main.bib --use-scholar --headless

# Whole file
bib-check audit path/to/main.bib
```

**Output** (in `./out/` by default):

| File | Content |
|------|---------|
| `report.md` | Per-entry diff, issues, match metadata |
| `suggested.bib` | Rewritten entries in unified style |
| `cache/` | JSON caches per source — delete to force re-query |

---

## Browser UI

The `docs/` directory contains a fully-client-side web app hosted on GitHub Pages:

- **Zero server** — parses `.bib` in-browser, queries OpenAlex + Crossref + Semantic Scholar via CORS.
- **Live diff** — unified diff (LCS-based) between original and suggested entry.
- **View filters** — show errors-only / hide clean / hide trusted / collapse info notes.
- **Export** — download `suggested.bib`, `report.json`, `report.md`, or copy-all.
- **Persistence** — bib input and results saved to `localStorage`, restored on refresh.
- **Privacy** — no bib content leaves your machine except title + author hint sent to the APIs.

Try it: [chenyuheee.github.io/bib-check](https://chenyuheee.github.io/bib-check/)

---

## Notes

This is a **suggestion engine**, not an oracle. Scholar metadata is sometimes wrong — especially author lists for very recent arXiv papers. Always eyeball `report.md` before copying entries into your bibliography.

---

## Author

**He Chenyu** — Zhejiang University
- Email: [hechenyu@zju.edu.cn](mailto:hechenyu@zju.edu.cn)
- Issues: [github.com/ChenyuHeee/bib-check/issues](https://github.com/ChenyuHeee/bib-check/issues)
