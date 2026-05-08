"""DBLP source: query the public JSON API and convert to ScholarResult.

DBLP is the primary lookup because it has no CAPTCHA / IP block, returns
canonical author lists, full venue names, and volume/number/pages. We re-use
the ScholarResult dataclass so the rewriter doesn't care which source the
metadata came from.

API docs: https://dblp.org/faq/13501473.html
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

from .scholar import ScholarResult, _is_preprint

API = "https://dblp.org/search/publ/api"

# Map common DBLP venue acronyms / streams to the full conference / journal name
# that should appear in `booktitle` or `journal`. Extend as needed.
VENUE_FULL_NAME = {
    # ML / NLP
    "neurips": "Advances in Neural Information Processing Systems",
    "nips": "Advances in Neural Information Processing Systems",
    "icml": "International Conference on Machine Learning",
    "iclr": "International Conference on Learning Representations",
    "acl": "Annual Meeting of the Association for Computational Linguistics",
    "emnlp": "Conference on Empirical Methods in Natural Language Processing",
    "naacl": "Conference of the North American Chapter of the Association for Computational Linguistics",
    "aaai": "AAAI Conference on Artificial Intelligence",
    "ijcai": "International Joint Conference on Artificial Intelligence",
    "colm": "Conference on Language Modeling",
    # Vision
    "cvpr": "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    "iccv": "IEEE/CVF International Conference on Computer Vision",
    "eccv": "European Conference on Computer Vision",
    # Systems / DB
    "osdi": "USENIX Symposium on Operating Systems Design and Implementation",
    "sosp": "ACM Symposium on Operating Systems Principles",
    "nsdi": "USENIX Symposium on Networked Systems Design and Implementation",
    "atc": "USENIX Annual Technical Conference",
    "eurosys": "European Conference on Computer Systems",
    "asplos": "International Conference on Architectural Support for Programming Languages and Operating Systems",
    "isca": "International Symposium on Computer Architecture",
    "micro": "IEEE/ACM International Symposium on Microarchitecture",
    "hpca": "IEEE International Symposium on High-Performance Computer Architecture",
    "fast": "USENIX Conference on File and Storage Technologies",
    "vldb": "International Conference on Very Large Data Bases",
    "sigmod": "ACM SIGMOD International Conference on Management of Data",
    "kdd": "ACM SIGKDD Conference on Knowledge Discovery and Data Mining",
    "www": "ACM Web Conference",
    "sigir": "ACM SIGIR Conference on Research and Development in Information Retrieval",
    # Security
    "ccs": "ACM SIGSAC Conference on Computer and Communications Security",
    "ndss": "Network and Distributed System Security Symposium",
    "uss": "USENIX Security Symposium",
    "sp": "IEEE Symposium on Security and Privacy",
    # SE / PL
    "icse": "International Conference on Software Engineering",
    "fse": "ACM Joint European Software Engineering Conference and Symposium on the Foundations of Software Engineering",
    "ase": "IEEE/ACM International Conference on Automated Software Engineering",
    "issta": "International Symposium on Software Testing and Analysis",
    "pldi": "ACM SIGPLAN Conference on Programming Language Design and Implementation",
    "popl": "ACM SIGPLAN Symposium on Principles of Programming Languages",
    "oopsla": "ACM SIGPLAN International Conference on Object-Oriented Programming, Systems, Languages, and Applications",
}


class DBLPClient:
    def __init__(self, cache_dir: str | Path = "cache_dblp", delay_seconds: float = 2.0) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.delay_seconds = delay_seconds
        self._last = 0.0

    # context-manager API for symmetry with ScholarClient
    def __enter__(self) -> "DBLPClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def lookup(self, title: str, authors_hint: str = "") -> ScholarResult | None:
        query = self._build_query(title, authors_hint)
        cached = self._load_cache(query)
        if cached is not None:
            return _from_cache(cached) if cached else None

        hits = self._search(query)
        # Distinguish "API failed" (don't cache) from "API said no match" (cache).
        if hits is None:
            return None
        best = _pick_best(title, hits)
        self._save_cache(query, _to_cache(best) if best else {})
        return best

    # ---- internals ----

    def _build_query(self, title: str, authors_hint: str) -> str:
        # DBLP's `q` accepts free text; first author last name helps disambiguate.
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
        elapsed = time.monotonic() - self._last
        if elapsed < self.delay_seconds:
            time.sleep(self.delay_seconds - elapsed)
        self._last = time.monotonic()

    def _search(self, query: str) -> list[dict] | None:
        """Return DBLP hits, [] for "no result", or None on transport failure."""
        params = urllib.parse.urlencode({"q": query, "format": "json", "h": "10"})
        url = f"{API}?{params}"
        for attempt in range(5):
            self._throttle()
            try:
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent": "bib-check/0.2 (academic bibliography linter)"},
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 4:
                    wait = 5 * (2 ** attempt)
                    print(
                        f"    [dblp] HTTP {exc.code}, retrying in {wait}s "
                        f"(attempt {attempt + 1}/5)",
                        flush=True,
                    )
                    time.sleep(wait)
                    continue
                print(f"    [dblp] HTTP error: {exc}", flush=True)
                return None
            except urllib.error.URLError as exc:
                print(f"    [dblp] network error: {exc}", flush=True)
                return None
            except json.JSONDecodeError:
                return None
        else:
            return None

        result = payload.get("result", {})
        hits_block = result.get("hits", {}) or {}
        raw_hits = hits_block.get("hit") or []
        return [h.get("info", {}) for h in raw_hits if isinstance(h, dict)]


# ---------- conversion ----------


def _author_list(info: dict) -> list[str]:
    a = info.get("authors")
    if not a:
        return []
    raw = a.get("author")
    if raw is None:
        return []
    if isinstance(raw, dict):
        raw = [raw]
    out: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            name = item.get("text", "").strip()
        else:
            name = str(item).strip()
        # DBLP appends disambiguation digits like "John Smith 0001". Drop them.
        name = re.sub(r"\s+\d{4}$", "", name)
        if name:
            out.append(name)
    return out


def _to_scholar_result(info: dict) -> ScholarResult:
    title = (info.get("title") or "").strip().rstrip(".")
    authors = _author_list(info)
    year = str(info.get("year") or "") or None
    venue_acronym = (info.get("venue") or "").strip()
    venue_full = _expand_venue(venue_acronym)
    pub_type = (info.get("type") or "").lower()  # 'Conference and Workshop Papers' etc.

    if "conference" in pub_type or "workshop" in pub_type:
        entry_type = "inproceedings"
        venue_kind: str | None = "booktitle"
    elif "journal" in pub_type or "article" in pub_type:
        entry_type = "article"
        venue_kind = "journal"
    elif "informal" in pub_type or venue_acronym.lower() == "corr":
        entry_type = "article"
        venue_kind = "journal"
        venue_full = "arXiv"
    else:
        entry_type = "misc"
        venue_kind = None

    volume = str(info.get("volume") or "") or None
    number = str(info.get("number") or "") or None
    pages = str(info.get("pages") or "") or None
    publisher = (info.get("publisher") or "").strip() or None

    return ScholarResult(
        title=title,
        authors=authors,
        year=year,
        venue=venue_full,
        venue_kind=venue_kind,
        volume=volume,
        number=number,
        pages=pages,
        publisher=publisher,
        entry_type=entry_type,
        raw_bibtex="",  # DBLP also exports BibTeX but we already have everything
        raw_meta=f"DBLP venue={venue_acronym!r} type={pub_type!r}",
    )


def _expand_venue(acronym: str) -> str:
    if not acronym:
        return ""
    key = acronym.lower().strip()
    if key in VENUE_FULL_NAME:
        return VENUE_FULL_NAME[key]
    # If DBLP gave a multi-word name, keep as is.
    if " " in acronym or len(acronym) > 8:
        return acronym
    # Unknown short token — keep but flag (the normalizer's "looks_abbreviated"
    # heuristic will warn).
    return acronym


def _pick_best(target_title: str, hits: list[dict]) -> ScholarResult | None:
    if not hits:
        return None
    target = re.sub(r"[^a-z0-9 ]+", " ", target_title.lower())
    scored: list[tuple[float, dict]] = []
    for info in hits:
        cand_title = re.sub(r"[^a-z0-9 ]+", " ", (info.get("title") or "").lower())
        s = fuzz.token_set_ratio(target, cand_title)
        scored.append((s, info))
    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, best = scored[0]
    if best_score < 75:
        return None

    # Prefer non-arXiv (i.e. published) hit if present and reasonably matched.
    for s, info in scored:
        if s < max(best_score - 5, 75):
            continue
        venue = (info.get("venue") or "").lower()
        ptype = (info.get("type") or "").lower()
        if venue == "corr" or "informal" in ptype:
            continue
        return _to_scholar_result(info)
    return _to_scholar_result(best)


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


def _from_cache(d: dict) -> ScholarResult | None:
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


__all__ = ["DBLPClient", "_is_preprint"]
