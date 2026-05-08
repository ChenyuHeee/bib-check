# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install (editable) + browser dependency for Scholar scraping
pip install -e .
playwright install chromium

# List entries with 1-indexed positions
bib-check list path/to/main.bib | head

# Audit a slice (1-indexed, inclusive)
bib-check audit path/to/main.bib --range 77-117

# Audit specific cite keys
bib-check audit path/to/main.bib --keys key1,key2

# Local checks only — no network calls
bib-check audit path/to/main.bib --range 77-117 --skip-openalex --skip-crossref --skip-dblp

# Include Google Scholar fallback (headless browser)
bib-check audit path/to/main.bib --use-scholar --headless

# Output defaults to ./out/ (report.md, suggested.bib, cache/)
```

There are no tests yet. The browser-based UI under `docs/` can be tested by opening `docs/index.html` directly or via GitHub Pages at `https://chenyuheee.github.io/bib-check/`.

## Architecture

### Lookup pipeline (first hit wins)

1. **OpenAlex** (`openalex.py`) — primary source. Free REST API, ~250M works, resolves arXiv preprints to published versions. Title+author search with retry.
2. **Crossref** (`crossref.py`) — used when OpenAlex returns a preprint or misses. Only upgrades when title match score ≥ 88 (with author-lastname check). Prefers non-`posted-content` hits.
3. **DBLP** (`dblp.py`) — tertiary fallback. Good venue acronyms, but was unreliable (5xx errors) so moved behind OpenAlex/Crossref.
4. **Google Scholar** (`scholar.py`) — opt-in via `--use-scholar`. Drives a real Chromium via Playwright (Cite→BibTeX click-through per result). Persistent browser profile in `cache/_profile` so CAPTCHA solves survive runs.

All sources return the shared `ScholarResult` dataclass (defined in `scholar.py`). `checker.py` orchestrates the cascade for each entry.

### CLI (`cli.py`)

Two subcommands via Click: `bib-check list` (enumerate entries with 1-indexed positions, skipping `@string/@preamble/@comment`) and `bib-check audit` (run the full lookup+rewrite pipeline). Range/key filtering happens before any network calls.

### Parser (`parser.py`)

Hand-rolled BibTeX parser — no `bibtexparser` dependency. Skips `@string`, `@preamble`, `@comment` blocks. Brace-depth tracking for field values. Returns `BibEntry` dataclass with 1-indexed positions and original line numbers.

### Normalizer (`normalizer.py`)

Two concerns:
- `detect_issues()` — flags missing authors/title/year/venue, `et al.` truncation, abbreviated venue names, arXiv-like venues, missing journal fields (volume/number/pages).
- `rewrite()` — merges Scholar metadata into the original entry, strips forbidden fields (doi, url, eprint, etc.), normalizes authors to "Last, First" form, expands venue acronyms using a hardcoded dictionary, drops arXiv pseudo-volumes, and orders fields for stable output.

### Browser UI (`docs/`)

Self-contained JS port for GitHub Pages. Pure browser-side: parses `.bib`, queries OpenAlex + Crossref + Semantic Scholar via CORS, renders git-style unified diffs with issue badges. No bib content leaves the machine except title+author hints to the APIs. Supports localStorage persistence, export buttons (suggested.bib, report.json, report.md, copy-all), and view filters (errors-only, hide clean, hide trusted, collapse info notes).

## Key design decisions

- `rapidfuzz` `token_sort_ratio` (not `token_set_ratio`) for title matching — `token_set_ratio` scores false positives near 100 for partial-title collisions.
- All API clients use SHA-256-hashed query caches in subdirectories under the output dir. Delete cache files to force re-query.
- Scholar `delay_seconds` defaults to 8s to avoid rate limiting. OpenAlex/Crossref use 0.5s, DBLP uses 2s.
- The `ScholarResult.raw_bibtex` field holds the exact BibTeX Scholar exported; `raw_meta` holds the gray meta line for debugging.
