# bib-check live audit

Open `index.html` directly or visit the GitHub Pages site:

  https://chenyuheee.github.io/bib-check/

Paste a `.bib` file. The page parses it in your browser, queries OpenAlex
and Crossref over CORS for each entry, then renders:

- Original vs suggested entry with line-level diff
- Source badge (OpenAlex / Crossref / unmatched)
- Issue badges (errors / warnings)
- Per-entry match metadata

No bib content leaves your machine except the title and author hint sent to
api.openalex.org / api.crossref.org.

To enable Pages: GitHub repo → Settings → Pages → Source = `Deploy from a
branch` → Branch = `main`, folder = `/docs`.
