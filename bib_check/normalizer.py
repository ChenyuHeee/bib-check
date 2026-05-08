"""Normalize BibTeX entries to the project's unified style.

Standard:
- All authors fully listed (no `et al.`).
- Required fields: author, title, year + venue (booktitle/journal).
- Journals: include volume, number, pages.
- Conferences: full booktitle; no abbreviations.
- Strip: doi, url, eprint, eprinttype, biburl, bibsource, timestamp, note,
  publisher (kept only if user wants -- we drop it by default to stay clean).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .parser import BibEntry

# Fields we always strip from the rewritten entry.
FORBIDDEN_FIELDS = {
    "doi",
    "url",
    "eprint",
    "eprinttype",
    "archiveprefix",
    "biburl",
    "bibsource",
    "timestamp",
    "issn",
    "isbn",
    "abstract",
    "keywords",
    "month",
}

ARXIV_VENUE_HINTS = ("corr", "arxiv", "preprint", "techrxiv", "authorea")


@dataclass
class Issue:
    severity: str  # 'error' | 'warning' | 'info'
    field: str | None
    message: str


def detect_issues(entry: BibEntry) -> list[Issue]:
    issues: list[Issue] = []
    f = entry.fields

    # Authors
    author = f.get("author", "").strip()
    if not author:
        issues.append(Issue("error", "author", "missing author"))
    elif _has_etal(author):
        issues.append(Issue("error", "author", "author list contains et al./others"))

    # Title
    if not f.get("title"):
        issues.append(Issue("error", "title", "missing title"))

    # Year
    if not f.get("year"):
        issues.append(Issue("error", "year", "missing year"))

    # Venue
    venue = _venue_text(entry)
    if not venue:
        issues.append(Issue("error", "venue", "missing booktitle/journal"))
    elif _looks_like_arxiv(venue):
        issues.append(
            Issue(
                "warning",
                "journal",
                f"venue looks like a preprint server ({venue!r}); search for the published version",
            )
        )
    elif entry.entry_type == "inproceedings" and _looks_abbreviated(venue):
        issues.append(
            Issue(
                "warning",
                "booktitle",
                f"booktitle may be abbreviated ({venue!r}); use full conference name",
            )
        )

    # Journal completeness
    if entry.entry_type == "article" and not _looks_like_arxiv(venue):
        for k in ("volume", "number", "pages"):
            if not f.get(k):
                issues.append(Issue("warning", k, f"missing {k}"))

    # Forbidden fields
    for k in sorted(FORBIDDEN_FIELDS & set(f.keys())):
        issues.append(Issue("info", k, f"field `{k}` will be stripped"))

    return issues


def _has_etal(author: str) -> bool:
    a = author.lower()
    return bool(
        re.search(r"\bet\.?\s*al\.?\b", a)
        or "and others" in a
        or "the others" in a
    )


def _venue_text(entry: BibEntry) -> str:
    return (entry.fields.get("booktitle") or entry.fields.get("journal") or "").strip()


def _looks_like_arxiv(venue: str) -> bool:
    v = venue.lower()
    return any(h in v for h in ARXIV_VENUE_HINTS)


def _looks_abbreviated(venue: str) -> bool:
    """Heuristic: short, dot-heavy, or single-token venues are likely abbreviations."""
    v = venue.strip()
    if len(v) <= 12:
        return True
    if re.search(r"\b[A-Z]{3,}\b", v) and "Conference" not in v and "Proceedings" not in v:
        return True
    if v.count(".") >= 2:
        return True
    return False


# ---------- Rewriting ----------


def rewrite(entry: BibEntry, scholar: dict | None) -> str:
    """Emit a normalized BibTeX entry string.

    Scholar metadata (when available) overrides the original for author /
    title / year / venue / volume / number / pages.
    """
    src = dict(entry.fields)

    if scholar:
        for k in ("author", "title", "year", "volume", "number", "pages"):
            if scholar.get(k):
                src[k] = scholar[k]
        venue = scholar.get("venue")
        venue_kind = scholar.get("venue_kind")  # 'journal' | 'booktitle' | None
        if venue and venue_kind:
            # Move to the correct field, drop the other.
            other = "journal" if venue_kind == "booktitle" else "booktitle"
            src[venue_kind] = venue
            src.pop(other, None)

    # Strip forbidden fields.
    for k in FORBIDDEN_FIELDS:
        src.pop(k, None)

    # Decide entry type from the venue we ended up with.
    entry_type = entry.entry_type
    if "booktitle" in src and not src.get("journal"):
        entry_type = "inproceedings"
    elif "journal" in src and not src.get("booktitle"):
        entry_type = "article"

    # Field ordering for stable output.
    if entry_type == "article":
        order = ["author", "title", "journal", "volume", "number", "pages", "year", "publisher"]
    else:
        order = ["author", "title", "booktitle", "pages", "year", "address", "publisher", "organization"]

    lines = [f"@{entry_type}{{{entry.cite_key},"]
    seen: set[str] = set()
    for k in order:
        if k in src and src[k]:
            lines.append(f"  {k:<10}= {{{src[k]}}},")
            seen.add(k)
    # Append any leftover non-forbidden fields for transparency.
    for k, v in src.items():
        if k in seen or k in FORBIDDEN_FIELDS or not v:
            continue
        lines.append(f"  {k:<10}= {{{v}}},")
    # Strip trailing comma on the last field.
    if lines[-1].endswith(","):
        lines[-1] = lines[-1][:-1]
    lines.append("}")
    return "\n".join(lines)
