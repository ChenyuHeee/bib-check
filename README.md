# bib-check

Audit BibTeX entries against Google Scholar and rewrite them to a unified
academic style.

## Standard enforced

For every entry the rewriter aims to satisfy:

1. **All authors listed** — no `et al.` / `the others` / truncation.
2. **Required fields**: `author`, `title`, `year`, plus venue
   (`booktitle` for conferences, `journal` for articles).
   - Conferences use the **full** name (no abbreviations like *Proc. NeurIPS*).
   - Journals must include `volume`, `number`, `pages`.
   - **No** `doi`, `url`, `eprint`, `eprinttype`, `biburl`, `bibsource`,
     `timestamp`.
3. **Prefer the published version** over arXiv/CoRR. If a paper has a
   peer-reviewed venue on Scholar, that one is selected.

## Install

```bash
cd bib_check
python -m venv .venv && source .venv/bin/activate
pip install -e .
playwright install chromium
```

## Usage

```bash
# 1) Find the right indices for the slice you care about.
bib-check list ../tokenomics_overleaf/main.bib | head

# 2) Audit a slice (1-indexed positions reported by `list`, inclusive).
bib-check audit ../tokenomics_overleaf/main.bib --range 77-117

# Whole file
bib-check audit ../tokenomics_overleaf/main.bib

# Specific cite keys
bib-check audit ../tokenomics_overleaf/main.bib \
    --keys kriuk2025qkvcomm,liu2024droidspeak

# Local checks only (no Scholar / no browser)
bib-check audit ../tokenomics_overleaf/main.bib --range 77-117 --skip-scholar
```

> Note on indexing: `bib-check`'s position counter skips `@string` /
> `@preamble` / `@comment` blocks, so it can differ from a naive
> `grep '^@'` count. Use `bib-check list` to find the right numbers, or
> just pass `--keys`.

Outputs (in `./out/`):

- `report.md` — per-entry diff between original and Scholar-recommended form.
- `suggested.bib` — rewritten entries in the unified style.
- `cache/` — JSON cache of Scholar query results (delete to re-query).

## How Scholar scraping works

Scholar has no public API and aggressively rate-limits / shows CAPTCHA.
This tool drives a real Chromium via Playwright (default `headless=False`)
so you can solve any CAPTCHA manually once per session. All results are
cached on disk by query hash, so re-runs do not re-hit Scholar.

Use `--headless` to force background mode (only when you have a fresh IP).

## Notes

This is a *suggestion engine*, not an oracle. Always eyeball `report.md`
before copying entries into your bibliography — Scholar metadata is
sometimes wrong (especially author lists for very new arXiv papers).
