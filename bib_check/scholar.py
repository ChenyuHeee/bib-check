"""Google Scholar lookup via Playwright — Cite → BibTeX click-through.

Scholar's gray meta line under each result is lossy (initials only, "..." for
4+ authors). To get the canonical author list / venue / volume / number /
pages, we click each result's "Cite" button and follow the BibTeX export link.

Flow per query:
  1. Navigate to /scholar?q=...
  2. For up to N top results, click "Cite", read the BibTeX anchor's href
     out of the modal, then GET the .bib URL via the same browser context
     (cookies / CAPTCHA solve carry over).
  3. Parse the returned BibTeX entry. That's the source of truth.
  4. Pick the best match by fuzzy title score, preferring non-preprint venues.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.parse
from dataclasses import dataclass, asdict
from html import unescape as _html_unescape
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz


@dataclass
class ScholarResult:
    title: str
    authors: list[str]
    year: str | None
    venue: str | None
    venue_kind: str | None  # 'journal' | 'booktitle' | None
    volume: str | None = None
    number: str | None = None
    pages: str | None = None
    publisher: str | None = None
    entry_type: str = "misc"
    raw_bibtex: str = ""  # exact BibTeX as Scholar exported it
    raw_meta: str = ""    # gray meta line (fallback / debugging)

    def to_normalized(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "author": " and ".join(self.authors) if self.authors else "",
            "title": self.title,
            "year": self.year or "",
            "venue": self.venue or "",
            "venue_kind": self.venue_kind,
        }
        if self.volume:
            d["volume"] = self.volume
        if self.number:
            d["number"] = self.number
        if self.pages:
            d["pages"] = self.pages
        if self.publisher:
            d["publisher"] = self.publisher
        return d


class ScholarClient:
    BASE = "https://scholar.google.com/scholar"

    def __init__(
        self,
        cache_dir: str | Path = "cache",
        headless: bool = False,
        delay_seconds: float = 4.0,
        max_results: int = 4,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.headless = headless
        self.delay_seconds = delay_seconds
        self.max_results = max_results
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._last_request = 0.0

    # ---- lifecycle ----

    def __enter__(self) -> "ScholarClient":
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=self.headless)
        self._context = self._browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        self._page = self._context.new_page()
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            if self._browser:
                self._browser.close()
        finally:
            if self._pw:
                self._pw.stop()

    # ---- public ----

    def lookup(self, title: str, authors_hint: str = "") -> ScholarResult | None:
        query = self._build_query(title, authors_hint)
        cached = self._load_cache(query)
        if cached is not None:
            return _from_dict(cached) if cached else None

        results = self._search_with_bibtex(query)
        best = _pick_best(title, results)
        self._save_cache(query, asdict(best) if best else {})
        return best

    # ---- internals ----

    def _build_query(self, title: str, authors_hint: str) -> str:
        parts = [title]
        if authors_hint:
            first = authors_hint.split(" and ")[0].strip()
            last = first.split(",")[0].split()[-1] if first else ""
            if last:
                parts.append(last)
        return " ".join(parts)

    def _cache_path(self, query: str) -> Path:
        h = hashlib.sha256(query.encode("utf-8")).hexdigest()[:20]
        return self.cache_dir / f"{h}.json"

    def _load_cache(self, query: str) -> dict | None:
        p = self._cache_path(query)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None

    def _save_cache(self, query: str, data: dict) -> None:
        self._cache_path(query).write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self.delay_seconds:
            time.sleep(self.delay_seconds - elapsed)
        self._last_request = time.monotonic()

    # ---- search + cite click-through ----

    def _search_with_bibtex(self, query: str) -> list[ScholarResult]:
        assert self._page is not None
        self._throttle()
        url = f"{self.BASE}?q={urllib.parse.quote(query)}&hl=en"
        self._page.goto(url, wait_until="domcontentloaded", timeout=45000)
        self._maybe_solve_captcha()

        try:
            self._page.wait_for_selector("div.gs_r.gs_or", timeout=15000)
        except Exception:
            return []

        cards = self._page.locator("div.gs_r.gs_or")
        n = min(cards.count(), self.max_results)
        out: list[ScholarResult] = []
        for i in range(n):
            try:
                card = cards.nth(i)
                title_text = _clean_title(self._safe_text(card, "h3.gs_rt"))
                meta = self._safe_text(card, "div.gs_a")
                bibtex = self._fetch_bibtex_for(card)
                if bibtex:
                    parsed = _parse_single_bibtex(bibtex)
                    parsed.raw_meta = meta
                    if not parsed.title:
                        parsed.title = title_text
                    out.append(parsed)
                else:
                    authors, year, venue = _split_author_line(meta)
                    out.append(
                        ScholarResult(
                            title=title_text,
                            authors=authors,
                            year=year,
                            venue=venue,
                            venue_kind=_classify_venue(venue) if venue else None,
                            raw_meta=meta,
                        )
                    )
            except Exception as exc:  # noqa: BLE001
                print(f"    [scholar] result #{i} skipped: {exc}", flush=True)
                continue
        return out

    def _fetch_bibtex_for(self, card) -> str | None:
        """Click the Cite button on a result card, then fetch its BibTeX URL.

        We open the BibTeX link in a new tab and read the served text/<pre>.
        Falling back to context.request.get when no popup happens.
        """
        assert self._page is not None and self._context is not None

        cite = card.locator("a.gs_or_cit")
        if cite.count() == 0:
            print("    [scholar] no Cite link on card", flush=True)
            return None
        try:
            cite.first.click(timeout=8000)
        except Exception as exc:
            print(f"    [scholar] cite click failed: {exc}", flush=True)
            return None

        try:
            self._page.wait_for_selector("#gs_citi a", timeout=8000)
        except Exception:
            print("    [scholar] cite modal did not open", flush=True)
            self._dismiss_cite_modal()
            return None

        href: str | None = None
        anchors = self._page.locator("#gs_citi a")
        for j in range(anchors.count()):
            try:
                txt = anchors.nth(j).inner_text(timeout=1500).strip().lower()
            except Exception:
                continue
            if txt == "bibtex":
                href = anchors.nth(j).get_attribute("href")
                break
        if not href:
            print("    [scholar] no BibTeX link in modal", flush=True)
            self._dismiss_cite_modal()
            return None
        if href.startswith("/"):
            href = "https://scholar.google.com" + href

        # Open in a new page so the search results page is preserved.
        text: str | None = None
        try:
            new_page = self._context.new_page()
            new_page.goto(href, wait_until="domcontentloaded", timeout=20000)
            body = new_page.content()
            new_page.close()
            # Scholar serves BibTeX as text/plain inside a <pre> wrapper.
            m = re.search(r"<pre[^>]*>(.*?)</pre>", body, re.DOTALL | re.IGNORECASE)
            if m:
                text = _html_unescape(m.group(1)).strip()
            else:
                # Sometimes the response is raw text, surfaced directly.
                stripped = re.sub(r"<[^>]+>", "", body).strip()
                if stripped.startswith("@"):
                    text = stripped
        except Exception as exc:
            print(f"    [scholar] BibTeX fetch failed: {exc}", flush=True)

        self._dismiss_cite_modal()

        if not text or "@" not in text:
            print("    [scholar] BibTeX response empty or blocked", flush=True)
            return None
        return text

    def _dismiss_cite_modal(self) -> None:
        assert self._page is not None
        try:
            self._page.locator("#gs_cit-x").first.click(timeout=2000)
        except Exception:
            try:
                self._page.keyboard.press("Escape")
            except Exception:
                pass

    def _maybe_solve_captcha(self) -> None:
        assert self._page is not None
        try:
            html = self._page.content().lower()
        except Exception:
            return
        if (
            "unusual traffic" in html
            or "please show you're not a robot" in html
            or "/sorry/" in (self._page.url or "")
        ):
            print(
                "\n[scholar] CAPTCHA detected. Solve it in the open browser, "
                "then press Enter here to continue.",
                flush=True,
            )
            input()
            try:
                self._page.wait_for_load_state("domcontentloaded")
            except Exception:
                pass

    @staticmethod
    def _safe_text(card, selector: str) -> str:
        loc = card.locator(selector)
        if loc.count() == 0:
            return ""
        try:
            return loc.first.inner_text(timeout=2000).strip()
        except Exception:
            return ""


# ---------- BibTeX parsing (single Scholar-exported entry) ----------


_PREPRINT_HOSTS = ("arxiv", "biorxiv", "techrxiv", "authorea", "ssrn", "preprint", "corr")
_FIELD_RE = re.compile(r"(\w+)\s*=\s*", re.MULTILINE)
_HEADER_RE = re.compile(r"@(\w+)\s*\{[^,]*,", re.DOTALL)


def _parse_single_bibtex(text: str) -> ScholarResult:
    header = _HEADER_RE.search(text)
    if not header:
        return ScholarResult(
            title="", authors=[], year=None, venue=None, venue_kind=None,
            raw_bibtex=text,
        )
    entry_type = header.group(1).lower()
    body = text[header.end():]
    end = body.rfind("}")
    if end != -1:
        body = body[:end]

    fields: dict[str, str] = {}
    matches = list(_FIELD_RE.finditer(body))
    for i, m in enumerate(matches):
        name = m.group(1).lower()
        start = m.end()
        stop = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        chunk = body[start:stop].strip()
        val = _extract_value(chunk)
        if val is not None:
            fields[name] = re.sub(r"\s+", " ", val).strip().rstrip(",").strip()

    authors_raw = fields.get("author", "")
    authors = [a.strip() for a in re.split(r"\s+and\s+", authors_raw) if a.strip()]

    venue = fields.get("journal") or fields.get("booktitle") or fields.get("publisher")
    if "journal" in fields:
        venue_kind = "journal"
    elif "booktitle" in fields:
        venue_kind = "booktitle"
    elif entry_type == "inproceedings":
        venue_kind = "booktitle"
    elif entry_type == "article":
        venue_kind = "journal"
    else:
        venue_kind = None

    return ScholarResult(
        title=fields.get("title", "").strip().strip("{}"),
        authors=authors,
        year=fields.get("year"),
        venue=venue,
        venue_kind=venue_kind,
        volume=fields.get("volume"),
        number=fields.get("number"),
        pages=fields.get("pages"),
        publisher=fields.get("publisher"),
        entry_type=entry_type,
        raw_bibtex=text.strip(),
    )


def _extract_value(chunk: str) -> str | None:
    if not chunk:
        return None
    if chunk[0] == "{":
        depth = 0
        for k, c in enumerate(chunk):
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return chunk[1:k]
        return chunk[1:]
    if chunk[0] == '"':
        end = chunk.find('"', 1)
        return chunk[1 : end if end != -1 else len(chunk)]
    return chunk.rstrip(",").rstrip("}").strip()


def _clean_title(s: str) -> str:
    return re.sub(r"^\[(PDF|HTML|BOOK|CITATION|B|C|H)\]\s*", "", s, flags=re.I).strip()


# ---------- gray-line fallback ----------


def _split_author_line(line: str) -> tuple[list[str], str | None, str | None]:
    if not line:
        return [], None, None
    parts = [p.strip() for p in line.split(" - ")]
    authors_raw = parts[0] if parts else ""
    authors = [a.strip() for a in authors_raw.split(",") if a.strip()]
    authors = [a for a in authors if a not in {"\u2026", "..."}]
    venue = None
    year = None
    if len(parts) >= 2:
        middle = parts[1]
        m = re.search(r"\b(19|20|21|22)\d{2}\b", middle)
        if m:
            year = m.group(0)
            venue = middle[: m.start()].rstrip(", ").strip()
        else:
            venue = middle.strip()
    return authors, year, venue or None


def _classify_venue(venue: str) -> str | None:
    v = venue.lower()
    if any(h in v for h in _PREPRINT_HOSTS):
        return "journal"
    if any(kw in v for kw in ("proceedings", "conference", "symposium", "workshop", "meeting")):
        return "booktitle"
    if any(kw in v for kw in ("journal", "transactions", "letters", "review", "communications", "magazine")):
        return "journal"
    return None


def _from_dict(d: dict) -> ScholarResult | None:
    if not d:
        return None
    return ScholarResult(
        title=d.get("title", ""),
        authors=d.get("authors") or [],
        year=d.get("year"),
        venue=d.get("venue"),
        venue_kind=d.get("venue_kind"),
        volume=d.get("volume"),
        number=d.get("number"),
        pages=d.get("pages"),
        publisher=d.get("publisher"),
        entry_type=d.get("entry_type", "misc"),
        raw_bibtex=d.get("raw_bibtex", ""),
        raw_meta=d.get("raw_meta", ""),
    )


def _pick_best(target_title: str, results: list[ScholarResult]) -> ScholarResult | None:
    if not results:
        return None
    target = re.sub(r"[^a-z0-9 ]+", " ", target_title.lower())
    scored: list[tuple[float, ScholarResult]] = []
    for r in results:
        cand = re.sub(r"[^a-z0-9 ]+", " ", (r.title or "").lower())
        score = fuzz.token_set_ratio(target, cand)
        scored.append((score, r))
    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, best = scored[0]
    if best_score < 70:
        return None
    # Prefer the highest-score result whose venue is not a preprint server.
    for s, r in scored:
        if s >= max(best_score - 5, 70) and r.venue and not _is_preprint(r.venue):
            return r
    return best


def _is_preprint(venue: str) -> bool:
    v = venue.lower()
    return any(h in v for h in _PREPRINT_HOSTS)
