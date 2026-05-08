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
    "note",
}

ARXIV_VENUE_HINTS = ("corr", "arxiv", "preprint", "techrxiv", "authorea", "ssrn")

# Common conference / journal acronym → full name. Used to expand abbreviated
# `booktitle` / `journal` even when no online source is available.
VENUE_FULL_NAME = {
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
    "cvpr": "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    "iccv": "IEEE/CVF International Conference on Computer Vision",
    "eccv": "European Conference on Computer Vision",
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
    "ccs": "ACM SIGSAC Conference on Computer and Communications Security",
    "ndss": "Network and Distributed System Security Symposium",
    "uss": "USENIX Security Symposium",
    "sp": "IEEE Symposium on Security and Privacy",
    "icse": "International Conference on Software Engineering",
    "fse": "ACM Joint European Software Engineering Conference and Symposium on the Foundations of Software Engineering",
    "ase": "IEEE/ACM International Conference on Automated Software Engineering",
    "issta": "International Symposium on Software Testing and Analysis",
    "pldi": "ACM SIGPLAN Conference on Programming Language Design and Implementation",
    "popl": "ACM SIGPLAN Symposium on Principles of Programming Languages",
    "oopsla": "ACM SIGPLAN International Conference on Object-Oriented Programming, Systems, Languages, and Applications",
    "uist": "ACM Symposium on User Interface Software and Technology",
    "chi": "ACM CHI Conference on Human Factors in Computing Systems",
    "tacl": "Transactions of the Association for Computational Linguistics",
}


def _expand_venue_acronym(venue: str) -> str:
    """If the venue is a bare acronym we recognize, expand to full name."""
    v = venue.strip()
    # Strip trailing year tokens like "ICLR 2023".
    m = re.match(r"^([A-Za-z]{2,8})(\s+\d{4})?$", v)
    if not m:
        return venue
    key = m.group(1).lower()
    return VENUE_FULL_NAME.get(key, venue)

# arXiv-style "abs/2401.12345" pseudo-volume from DBLP/Scholar exports.
_ARXIV_VOLUME_RE = re.compile(r"^\s*abs/\d{4}\.\d{4,5}\s*$", re.IGNORECASE)


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
        # Only warn if we don't have an automatic expansion for it.
        if _expand_venue_acronym(venue) == venue:
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


_NAME_PARTICLES = {"de", "del", "della", "der", "den", "van", "von", "la", "le", "di", "da", "du"}


def _normalize_one_name(name: str) -> str:
    name = name.strip()
    if not name:
        return name
    # Already "Last, First" form.
    if "," in name:
        return name
    parts = name.split()
    if len(parts) < 2:
        return name
    # Walk from the end to gather a multi-token surname (e.g. "van den Driessche").
    i = len(parts) - 1
    while i > 0 and parts[i - 1].lower() in _NAME_PARTICLES:
        i -= 1
    given = " ".join(parts[:i])
    family = " ".join(parts[i:])
    if not given or not family:
        return name
    return f"{family}, {given}"


def _normalize_authors(author_field: str) -> str:
    parts = re.split(r"\s+and\s+", author_field.strip())
    return " and ".join(_normalize_one_name(p) for p in parts if p.strip())


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
    title / year / venue / volume / number / pages. Scholar's entry_type
    (article vs inproceedings) wins when set.
    """
    src = dict(entry.fields)
    scholar_entry_type: str | None = None

    if scholar:
        for k in ("author", "title", "year", "volume", "number", "pages", "publisher"):
            if scholar.get(k):
                src[k] = scholar[k]
        venue = scholar.get("venue")
        venue_kind = scholar.get("venue_kind")  # 'journal' | 'booktitle' | None
        if venue and venue_kind:
            other = "journal" if venue_kind == "booktitle" else "booktitle"
            src[venue_kind] = venue
            src.pop(other, None)
        scholar_entry_type = scholar.get("entry_type")

    # Strip forbidden fields.
    for k in FORBIDDEN_FIELDS:
        src.pop(k, None)

    # Expand bare acronym venues like "ICLR" / "NeurIPS" to full names so that
    # standard "会议统一用全称不缩写" is met even when no online source matched.
    if src.get("booktitle"):
        src["booktitle"] = _expand_venue_acronym(src["booktitle"])
    if src.get("journal"):
        src["journal"] = _expand_venue_acronym(src["journal"])

    # Normalize author list to "Last, First" form for consistency.
    if src.get("author"):
        src["author"] = _normalize_authors(src["author"])

    # Drop arXiv pseudo-volume (e.g. "abs/2401.12345") if we ended up on a
    # preprint venue and have no real volume/number from Scholar.
    journal = src.get("journal", "")
    if journal and _looks_like_arxiv(journal):
        if "volume" in src and _ARXIV_VOLUME_RE.match(src["volume"] or ""):
            src.pop("volume", None)
        # arXiv has no issue number / pages, and the "Cornell University"
        # publisher metadata returned by some sources is misleading.
        for k in ("number", "pages", "publisher"):
            src.pop(k, None)

    # Decide entry type: prefer Scholar's, else infer from venue field.
    if scholar_entry_type in {"article", "inproceedings", "book", "incollection", "techreport"}:
        entry_type = scholar_entry_type
    elif "booktitle" in src and not src.get("journal"):
        entry_type = "inproceedings"
    elif "journal" in src and not src.get("booktitle"):
        entry_type = "article"
    else:
        entry_type = entry.entry_type

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
