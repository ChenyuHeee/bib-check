"""Crossref source.

Crossref has authoritative DOI metadata for journal articles and many
conference proceedings (ACL/EMNLP via ACL Anthology, ACM, IEEE, Springer,
Nature, etc.). It often catches papers OpenAlex misses.

API: https://github.com/CrossRef/rest-api-doc
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

API = "https://api.crossref.org/works"
UA = "bib-check/0.3 (mailto:bib-check@example.com)"


class CrossrefClient:
    def __init__(self, cache_dir: str | Path = "cache_crossref", delay_seconds: float = 0.5) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.delay_seconds = delay_seconds
        self._last = 0.0

    def __enter__(self) -> "CrossrefClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def lookup(self, title: str, authors_hint: str = "") -> ScholarResult | None:
        query = title.strip()
        cached = self._load_cache(query)
        if cached is not None:
            return _from_cache(cached) if cached else None

        hits = self._search(query)
        if hits is None:
            return None
        best = _pick_best(title, hits, authors_hint)
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
            "query.title": query,
            "rows": "10",
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
                        f"    [crossref] HTTP {exc.code}, retrying in {wait}s "
                        f"(attempt {attempt + 1}/4)",
                        flush=True,
                    )
                    time.sleep(wait)
                    continue
                print(f"    [crossref] HTTP error: {exc}", flush=True)
                return None
            except urllib.error.URLError as exc:
                print(f"    [crossref] network error: {exc}", flush=True)
                return None
            except json.JSONDecodeError:
                return None
        else:
            return None

        return ((payload.get("message") or {}).get("items") or [])


# ---------- conversion ----------


def _author_list(item: dict) -> list[str]:
    out: list[str] = []
    for a in item.get("author", []) or []:
        family = (a.get("family") or "").strip()
        given = (a.get("given") or "").strip()
        if family and given:
            out.append(f"{family}, {given}")
        elif family:
            out.append(family)
        elif a.get("name"):
            out.append(a["name"].strip())
    return out


def _year(item: dict) -> str | None:
    for k in ("issued", "published-print", "published-online", "created", "deposited"):
        d = item.get(k) or {}
        parts = d.get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            return str(parts[0][0])
    return None


def _to_scholar_result(item: dict) -> ScholarResult:
    title_list = item.get("title") or []
    title = (title_list[0] if title_list else "").strip().rstrip(".")
    authors = _author_list(item)
    year = _year(item)
    container = (item.get("container-title") or [None])[0]
    container = (container or "").strip()
    publisher = (item.get("publisher") or "").strip() or None
    volume = item.get("volume") or None
    number = item.get("issue") or None
    pages = item.get("page") or None
    if pages and "-" in pages and "--" not in pages:
        pages = pages.replace("-", "--")

    ctype = (item.get("type") or "").lower()
    # Crossref types: journal-article, proceedings-article, book-chapter, posted-content, ...
    if ctype == "proceedings-article":
        entry_type = "inproceedings"
        venue_kind: str | None = "booktitle"
    elif ctype in ("journal-article", "journal-issue", "journal-volume"):
        entry_type = "article"
        venue_kind = "journal"
    elif ctype == "posted-content":  # preprint
        entry_type = "article"
        venue_kind = "journal"
        if not container:
            container = "arXiv preprint"
    elif ctype in ("book-chapter", "book-part", "book-section"):
        entry_type = "incollection"
        venue_kind = "booktitle"
    elif ctype == "book":
        entry_type = "book"
        venue_kind = None
    else:
        entry_type = "article"
        venue_kind = "journal" if container else None

    return ScholarResult(
        title=title,
        authors=authors,
        year=year,
        venue=container,
        venue_kind=venue_kind,
        volume=str(volume) if volume else None,
        number=str(number) if number else None,
        pages=str(pages) if pages else None,
        publisher=publisher,
        entry_type=entry_type,
        raw_bibtex="",
        raw_meta=f"Crossref type={ctype!r} doi={item.get('DOI','')}",
    )


def _hint_lastnames(hint: str) -> set[str]:
    """Pull last-name tokens from the original `author = {...}` field.

    Handles both "Last, First and Last2, First2" and "First Last and First2 Last2".
    """
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


def _candidate_lastnames(item: dict) -> set[str]:
    out: set[str] = set()
    for a in item.get("author", []) or []:
        f = (a.get("family") or "").strip().lower()
        if f:
            out.add(f)
        elif a.get("name"):
            parts = a["name"].split()
            if parts:
                out.add(parts[-1].lower())
    return out


def _pick_best(target_title: str, hits: list[dict], authors_hint: str = "") -> ScholarResult | None:
    if not hits:
        return None
    target = re.sub(r"[^a-z0-9 ]+", " ", target_title.lower())
    hint_set = _hint_lastnames(authors_hint)
    scored: list[tuple[float, dict]] = []
    for item in hits:
        title_list = item.get("title") or []
        cand = title_list[0] if title_list else ""
        cand_norm = re.sub(r"[^a-z0-9 ]+", " ", cand.lower())
        s = fuzz.token_set_ratio(target, cand_norm)
        scored.append((s, item))
    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, _ = scored[0]
    if best_score < 88:
        return None

    # If we have author hints, require at least one shared last name unless
    # the title score is very high (>= 96) — this guards against partial-title
    # collisions like "Scaling Laws for Neural LMs" vs "Scaling Laws for Multilingual LMs".
    def _author_ok(item: dict, score: float) -> bool:
        if not hint_set:
            return True
        cand_set = _candidate_lastnames(item)
        return bool(hint_set & cand_set)

    # Prefer non-preprint when title matches well AND author overlap holds.
    for s, item in scored:
        if s < max(best_score - 3, 88):
            continue
        ctype = (item.get("type") or "").lower()
        if ctype == "posted-content":
            continue
        if not _author_ok(item, s):
            continue
        return _to_scholar_result(item)
    # Fall back to best non-preprint with author check, then to best overall
    # only if author check passes.
    for s, item in scored:
        if _author_ok(item, s):
            return _to_scholar_result(item)
    return None


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
