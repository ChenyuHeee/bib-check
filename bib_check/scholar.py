"""Google Scholar lookup via Playwright.

Scholar has no API. We drive a real Chromium so the user can solve CAPTCHAs
once per session. Results are cached on disk by query hash.

The DOM selectors below target the public Scholar HTML as of 2024-2026.
If Google changes the markup, update `_parse_result_block`.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.parse
from dataclasses import dataclass, asdict
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
    raw_meta: str = ""  # the gray "X - Y, Z - W" line as scraped

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
        return d


class ScholarClient:
    BASE = "https://scholar.google.com/scholar"

    def __init__(
        self,
        cache_dir: str | Path = "cache",
        headless: bool = False,
        delay_seconds: float = 4.0,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.headless = headless
        self.delay_seconds = delay_seconds
        self._pw = None
        self._browser = None
        self._page = None
        self._last_request = 0.0

    # ---- lifecycle ----

    def __enter__(self) -> "ScholarClient":
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=self.headless)
        ctx = self._browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        self._page = ctx.new_page()
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
        """Return the best Scholar match for `title`. Cached on disk."""
        query = self._build_query(title, authors_hint)
        cached = self._load_cache(query)
        if cached is not None:
            return _from_dict(cached) if cached else None

        results = self._search(query)
        best = _pick_best(title, results)
        self._save_cache(query, asdict(best) if best else {})
        return best

    # ---- internals ----

    def _build_query(self, title: str, authors_hint: str) -> str:
        parts = [title]
        if authors_hint:
            # Use the first author's last name as a disambiguator.
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

    def _search(self, query: str) -> list[ScholarResult]:
        assert self._page is not None
        self._throttle()
        url = f"{self.BASE}?q={urllib.parse.quote(query)}&hl=en"
        self._page.goto(url, wait_until="domcontentloaded", timeout=45000)

        # CAPTCHA / "unusual traffic" handling.
        if self._is_captcha():
            print(
                "\n[scholar] CAPTCHA detected. Solve it in the open browser, "
                "then press Enter here to continue.",
                flush=True,
            )
            input()
            self._page.wait_for_load_state("domcontentloaded")

        try:
            self._page.wait_for_selector("div.gs_ri", timeout=15000)
        except Exception:
            return []

        blocks = self._page.locator("div.gs_ri")
        n = min(blocks.count(), 5)
        out: list[ScholarResult] = []
        for i in range(n):
            try:
                out.append(self._parse_result_block(blocks.nth(i)))
            except Exception:
                continue
        return out

    def _is_captcha(self) -> bool:
        assert self._page is not None
        try:
            html = self._page.content().lower()
        except Exception:
            return False
        return (
            "unusual traffic" in html
            or "please show you're not a robot" in html
            or "/sorry/" in (self._page.url or "")
        )

    def _parse_result_block(self, block) -> ScholarResult:
        title = block.locator("h3.gs_rt").inner_text(timeout=5000).strip()
        title = re.sub(r"^\[(PDF|HTML|BOOK|CITATION|B|C|H)\]\s*", "", title, flags=re.I)
        authors_line = ""
        try:
            authors_line = block.locator("div.gs_a").inner_text(timeout=2000).strip()
        except Exception:
            pass

        authors, year, venue = _split_author_line(authors_line)
        venue_kind = _classify_venue(venue) if venue else None
        volume, number, pages = _extract_volume_pages(authors_line)

        return ScholarResult(
            title=title,
            authors=authors,
            year=year,
            venue=venue,
            venue_kind=venue_kind,
            volume=volume,
            number=number,
            pages=pages,
            raw_meta=authors_line,
        )


# ---------- parsing helpers ----------


_PREPRINT_HOSTS = ("arxiv", "biorxiv", "techrxiv", "authorea", "ssrn", "preprint")


def _split_author_line(line: str) -> tuple[list[str], str | None, str | None]:
    """Parse Scholar's gray meta line: 'A Smith, B Jones - Venue, 2024 - host'."""
    if not line:
        return [], None, None
    parts = [p.strip() for p in line.split(" - ")]
    authors_raw = parts[0] if parts else ""
    authors = [a.strip() for a in authors_raw.split(",") if a.strip()]
    # Drop a trailing "..." token.
    authors = [a for a in authors if a != "\u2026" and a != "..."]

    venue = None
    year = None
    if len(parts) >= 2:
        middle = parts[1]
        # Last 4-digit token is the year.
        m = re.search(r"\b(19|20|21|22)\d{2}\b", middle)
        if m:
            year = m.group(0)
            venue = middle[: m.start()].rstrip(", ").strip()
        else:
            venue = middle.strip()
    if not venue:
        venue = None
    return authors, year, venue


def _classify_venue(venue: str) -> str | None:
    v = venue.lower()
    if any(h in v for h in _PREPRINT_HOSTS):
        return "journal"  # keep as @article{... journal=arXiv} if nothing better
    if any(
        kw in v
        for kw in (
            "proceedings",
            "conference",
            "symposium",
            "workshop",
            "meeting",
            "icml",
            "neurips",
            "iclr",
            "acl",
            "emnlp",
            "naacl",
            "cvpr",
            "iccv",
            "eccv",
            "kdd",
            "www",
            "sigir",
            "sigmod",
            "vldb",
            "osdi",
            "sosp",
            "nsdi",
            "asplos",
            "isca",
            "micro",
            "hpca",
            "atc",
            "eurosys",
            "fast",
            "usenix security",
            "ndss",
            "ccs",
            "oakland",
            "pldi",
            "popl",
            "oopsla",
            "icse",
            "fse",
            "ase",
            "issta",
            "aaai",
            "ijcai",
        )
    ):
        return "booktitle"
    if any(
        kw in v
        for kw in ("journal", "transactions", "letters", "review", "communications", "magazine")
    ):
        return "journal"
    return None


def _extract_volume_pages(line: str) -> tuple[str | None, str | None, str | None]:
    """Pull volume/number/pages out of strings like '... 12(3), 45-67, 2024 - ...'."""
    if not line:
        return None, None, None
    m = re.search(r"\b(\d{1,4})\s*\((\d{1,4})\)\s*,?\s*([\d\u2013\-]+)?", line)
    if m:
        return m.group(1), m.group(2), (m.group(3) or None)
    m = re.search(r"\b(\d{1,4})\s*,\s*([\d\u2013\-]{3,})", line)
    if m:
        return m.group(1), None, m.group(2)
    return None, None, None


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
    # Prefer the highest-score result whose venue is *not* arXiv if any exists.
    for s, r in scored:
        if s >= max(best_score - 5, 70) and r.venue and not any(
            h in r.venue.lower() for h in _PREPRINT_HOSTS
        ):
            return r
    return best
