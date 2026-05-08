"""OpenAlex source: free, no-key, reliable JSON API.

Used as the primary metadata lookup because DBLP has been returning 5xx
errors and Google Scholar blocks scraping. OpenAlex covers ~250M works
and resolves arXiv preprints to their published version when possible.

API: https://docs.openalex.org/
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz

from .scholar import ScholarResult

API = "https://api.openalex.org/works"
# OpenAlex requests a contact email in User-Agent for the polite pool.
UA = "bib-check/0.3 (mailto:bib-check@example.com)"


class OpenAlexClient:
    def __init__(self, cache_dir: str | Path = "cache_openalex", delay_seconds: float = 0.5) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.delay_seconds = delay_seconds
        self._last = 0.0

    def __enter__(self) -> "OpenAlexClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def lookup(self, title: str, authors_hint: str = "") -> ScholarResult | None:
        query = title.strip()
        cached = self._load_cache(query)
        if cached is not None:
            return _from_cache(cached) if cached else None

        # Try the full title; if no usable match, retry with simplified query
        # (subtitle after first colon stripped, special chars removed). OpenAlex's
        # default `search` ranking is sensitive to punctuation and length.
        hits = self._search(query)
        if hits is None:
            return None
        best = _pick_best(title, hits, authors_hint)
        if best is None:
            simplified = _simplify_query(title)
            if simplified and simplified != query:
                more = self._search(simplified)
                if more:
                    best = _pick_best(title, more, authors_hint)
        if best is not None and _is_preprint_result(best):
            published = _find_published_alternate(hits, title)
            if published is not None:
                best = published
        self._save_cache(query, _to_cache(best) if best else {})
        return best

    # ---- internals ----

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
        elapsed = time.monotonic() - self._last
        if elapsed < self.delay_seconds:
            time.sleep(self.delay_seconds - elapsed)
        self._last = time.monotonic()

    def _search(self, query: str) -> list[dict] | None:
        params = urllib.parse.urlencode({
            "search": query,
            "per-page": "10",
        })
        url = f"{API}?{params}"
        for attempt in range(4):
            self._throttle()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 3:
                    wait = 3 * (2 ** attempt)
                    print(
                        f"    [openalex] HTTP {exc.code}, retrying in {wait}s "
                        f"(attempt {attempt + 1}/4)",
                        flush=True,
                    )
                    time.sleep(wait)
                    continue
                print(f"    [openalex] HTTP error: {exc}", flush=True)
                return None
            except urllib.error.URLError as exc:
                print(f"    [openalex] network error: {exc}", flush=True)
                return None
            except json.JSONDecodeError:
                return None
        else:
            return None

        return payload.get("results", []) or []


# ---------- conversion ----------


def _author_list(work: dict) -> list[str]:
    out: list[str] = []
    for a in work.get("authorships", []) or []:
        author = (a or {}).get("author") or {}
        name = (author.get("display_name") or "").strip()
        if name:
            out.append(name)
    return out


def _venue_info(work: dict) -> tuple[str, str | None, str]:
    """Return (venue_display_name, venue_kind, source_type).

    venue_kind is 'booktitle' for conferences, 'journal' for journals/preprints,
    or None if unknown. source_type is the OpenAlex `source.type` value.
    """
    loc = (work.get("primary_location") or {}) or {}
    src = (loc.get("source") or {}) or {}
    name = (src.get("display_name") or "").strip()
    stype = (src.get("type") or "").lower()  # journal, conference, repository, ebook, book, ...
    # Normalize arXiv label: OpenAlex returns "arXiv (Cornell University)".
    if "arxiv" in name.lower():
        name = "arXiv preprint"
    if stype == "conference":
        return name, "booktitle", stype
    if stype in ("journal", "ebook", "book series", "book"):
        return name, "journal", stype
    if stype == "repository":
        return name or "arXiv preprint", "journal", stype
    return name, "journal" if name else None, stype


def _to_scholar_result(work: dict) -> ScholarResult:
    title = (work.get("title") or work.get("display_name") or "").strip().rstrip(".")
    authors = _author_list(work)
    year = str(work.get("publication_year") or "") or None
    venue_name, venue_kind, src_type = _venue_info(work)

    biblio = work.get("biblio") or {}
    volume = (biblio.get("volume") or None) or None
    number = (biblio.get("issue") or None) or None
    first_page = biblio.get("first_page")
    last_page = biblio.get("last_page")
    if first_page and last_page and first_page != last_page:
        pages: str | None = f"{first_page}--{last_page}"
    elif first_page:
        pages = str(first_page)
    else:
        pages = None
    publisher = None
    src = ((work.get("primary_location") or {}).get("source") or {})
    publisher = (src.get("host_organization_name") or "").strip() or None

    work_type = (work.get("type") or "").lower()
    # OpenAlex types: article, book-chapter, dataset, preprint, dissertation,
    # book, review, paratext, other, reference-entry, report, ...
    if src_type == "conference" or work_type in ("proceedings-article", "proceedings"):
        entry_type = "inproceedings"
        if venue_kind is None:
            venue_kind = "booktitle"
    elif src_type == "repository" or work_type == "preprint":
        entry_type = "article"
        venue_kind = "journal"
        if not venue_name:
            venue_name = "arXiv"
    else:
        entry_type = "article"
        if venue_kind is None:
            venue_kind = "journal"

    return ScholarResult(
        title=title,
        authors=authors,
        year=year,
        venue=venue_name or "",
        venue_kind=venue_kind,
        volume=str(volume) if volume else None,
        number=str(number) if number else None,
        pages=pages,
        publisher=publisher,
        entry_type=entry_type,
        raw_bibtex="",
        raw_meta=f"OpenAlex type={work_type!r} src_type={src_type!r} id={work.get('id','')}",
    )


_PREPRINT_HOSTS = ("arxiv", "biorxiv", "ssrn", "techrxiv", "authorea", "medrxiv", "preprint")


def _simplify_query(title: str) -> str:
    """Drop the subtitle after the first colon and strip braces/punct so that
    OpenAlex's `search` ranker matches better on long, punctuated paper titles."""
    head = title.split(":", 1)[0]
    head = re.sub(r"[{}\\]", " ", head)
    head = re.sub(r"\s+", " ", head).strip()
    return head


def _is_preprint_result(r: ScholarResult) -> bool:
    v = (r.venue or "").lower()
    return any(h in v for h in _PREPRINT_HOSTS)


def _find_published_alternate(hits: list[dict], target_title: str) -> ScholarResult | None:
    """If the top hit is a preprint, see if any other returned work with the
    same title points to a real journal/conference."""
    target = re.sub(r"[^a-z0-9 ]+", " ", target_title.lower())
    for w in hits:
        cand_title = re.sub(r"[^a-z0-9 ]+", " ", (w.get("title") or "").lower())
        if fuzz.token_set_ratio(target, cand_title) < 85:
            continue
        _, _, src_type = _venue_info(w)
        if src_type in ("journal", "conference", "book", "book series", "ebook"):
            r = _to_scholar_result(w)
            if not _is_preprint_result(r):
                return r
    return None


def _pick_best(target_title: str, hits: list[dict], authors_hint: str = "") -> ScholarResult | None:
    if not hits:
        return None
    target = re.sub(r"[^a-z0-9 ]+", " ", target_title.lower())
    hint_set = _hint_lastnames(authors_hint)
    hint_first = _hint_first_lastname(authors_hint)
    scored: list[tuple[float, dict]] = []
    for w in hits:
        cand_title = re.sub(r"[^a-z0-9 ]+", " ", (w.get("title") or "").lower())
        s = fuzz.token_set_ratio(target, cand_title)
        scored.append((s, w))
    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, _ = scored[0]
    if best_score < 75:
        return None

    def _author_ok(w: dict, score: float) -> bool:
        if not hint_set:
            return True
        cand = {n.split()[-1].lower() for n in _author_list(w) if n.split()}
        if hint_first and hint_first not in cand:
            return False
        return bool(hint_set & cand)

    # Prefer published over preprint when title matches well AND author overlap.
    for s, w in scored:
        if s < max(best_score - 5, 80):
            continue
        _, _, src_type = _venue_info(w)
        if src_type not in ("journal", "conference", "book", "book series", "ebook"):
            continue
        if not _author_ok(w, s):
            continue
        return _to_scholar_result(w)
    # Fall back to top scoring hit, but still require author check.
    for s, w in scored:
        if _author_ok(w, s):
            return _to_scholar_result(w)
    return None


def _hint_lastnames(hint: str) -> set[str]:
    out: set[str] = set()
    for chunk in re.split(r"\s+and\s+", hint or ""):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "," in chunk:
            last = chunk.split(",", 1)[0].strip()
        else:
            last = chunk.split()[-1] if chunk.split() else ""
        last = re.sub(r"[{}\\]", "", last).lower()
        if last:
            out.add(last)
    return out


def _hint_first_lastname(hint: str) -> str:
    parts = re.split(r"\s+and\s+", hint or "", maxsplit=1)
    if not parts or not parts[0].strip():
        return ""
    chunk = parts[0].strip()
    if "," in chunk:
        last = chunk.split(",", 1)[0].strip()
    else:
        last = chunk.split()[-1] if chunk.split() else ""
    return re.sub(r"[{}\\]", "", last).lower()


# ---------- cache (de)serialization ----------


def _to_cache(r: ScholarResult) -> dict:
    return {
        "title": r.title,
        "authors": r.authors,
        "year": r.year,
        "venue": r.venue,
        "venue_kind": r.venue_kind,
        "volume": r.volume,
        "number": r.number,
        "pages": r.pages,
        "publisher": r.publisher,
        "entry_type": r.entry_type,
        "raw_bibtex": r.raw_bibtex,
        "raw_meta": r.raw_meta,
    }


def _from_cache(d: dict) -> ScholarResult:
    return ScholarResult(
        title=d.get("title", ""),
        authors=list(d.get("authors", [])),
        year=d.get("year"),
        venue=d.get("venue", ""),
        venue_kind=d.get("venue_kind"),
        volume=d.get("volume"),
        number=d.get("number"),
        pages=d.get("pages"),
        publisher=d.get("publisher"),
        entry_type=d.get("entry_type"),
        raw_bibtex=d.get("raw_bibtex", ""),
        raw_meta=d.get("raw_meta", ""),
    )
