"""Top-level audit pipeline.

Lookup order (first hit wins):
  1. OpenAlex — fast, ~250M works.
  2. Crossref — authoritative DOI metadata, catches what OpenAlex misses.
  3. DBLP — nice venue acronyms when up.
  4. Google Scholar — opt-in fallback (`--use-scholar`).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .crossref import CrossrefClient
from .dblp import DBLPClient
from .normalizer import Issue, detect_issues, rewrite
from .openalex import OpenAlexClient
from .parser import BibEntry, parse
from .scholar import ScholarClient, ScholarResult


_PREPRINT_VENUE_HINTS = ("arxiv", "biorxiv", "ssrn", "techrxiv", "authorea", "medrxiv", "preprint", "corr")


def _is_preprint(r: ScholarResult) -> bool:
    v = (r.venue or "").lower()
    return any(h in v for h in _PREPRINT_VENUE_HINTS)


def _title_match(a: str, b: str) -> float:
    import re as _re
    from rapidfuzz import fuzz as _fuzz
    na = _re.sub(r"[^a-z0-9 ]+", " ", (a or "").lower())
    nb = _re.sub(r"[^a-z0-9 ]+", " ", (b or "").lower())
    # Use sort-ratio (order-sensitive token comparison) instead of set-ratio:
    # token_set_ratio scores "Scaling Laws for Neural LMs" vs "Explaining
    # Neural Scaling Laws" near 100, which lets the wrong paper win.
    return _fuzz.token_sort_ratio(na, nb)


@dataclass
class AuditedEntry:
    entry: BibEntry
    issues: list[Issue]
    match: ScholarResult | None
    source: str  # 'openalex' | 'dblp' | 'scholar' | 'none'
    rewritten: str


def audit(
    bib_path: str | Path,
    selected_indices: set[int] | None = None,
    selected_keys: set[str] | None = None,
    cache_dir: str | Path = "out/cache",
    headless: bool = False,
    use_scholar: bool = False,
    skip_dblp: bool = False,
    skip_openalex: bool = False,
    skip_crossref: bool = False,
) -> list[AuditedEntry]:
    entries = parse(bib_path)
    targets = [
        e
        for e in entries
        if (selected_indices is None or e.index in selected_indices)
        and (selected_keys is None or e.cite_key in selected_keys)
    ]
    if not targets:
        return []

    cache_root = Path(cache_dir)
    out: list[AuditedEntry] = []

    openalex = (
        OpenAlexClient(cache_dir=cache_root / "openalex")
        if not skip_openalex
        else None
    )
    crossref = (
        CrossrefClient(cache_dir=cache_root / "crossref")
        if not skip_crossref
        else None
    )
    dblp = DBLPClient(cache_dir=cache_root / "dblp") if not skip_dblp else None
    scholar = (
        ScholarClient(cache_dir=cache_root / "scholar", headless=headless)
        if use_scholar
        else None
    )

    try:
        if scholar is not None:
            scholar.__enter__()
        for e in targets:
            issues = detect_issues(e)
            match: ScholarResult | None = None
            source = "none"
            title = e.fields.get("title", "")
            if title and openalex is not None:
                try:
                    match = openalex.lookup(title, e.fields.get("author", ""))
                    if match:
                        source = "openalex"
                except Exception as exc:  # noqa: BLE001
                    issues.append(Issue("warning", None, f"OpenAlex lookup failed: {exc}"))
            if title and (match is None or _is_preprint(match)) and crossref is not None:
                try:
                    cr = crossref.lookup(title, e.fields.get("author", ""))
                    if cr is not None and not _is_preprint(cr):
                        # Only swap in a Crossref hit when its title matches the
                        # query strongly. Otherwise we trade an arXiv preprint
                        # for an unrelated paper that happens to share the
                        # first-author surname.
                        if _title_match(title, cr.title) >= 92 or match is None:
                            if _title_match(title, cr.title) >= 88:
                                # When upgrading an OpenAlex preprint to a
                                # Crossref-published version, keep the OpenAlex
                                # author list. Crossref often returns authors
                                # in alphabetical order, which loses the
                                # original byline ordering.
                                if match is not None and match.authors:
                                    cr.authors = match.authors
                                match = cr
                                source = "crossref"
                except Exception as exc:  # noqa: BLE001
                    issues.append(Issue("warning", None, f"Crossref lookup failed: {exc}"))
            if title and match is None and dblp is not None:
                try:
                    match = dblp.lookup(title, e.fields.get("author", ""))
                    if match:
                        source = "dblp"
                except Exception as exc:  # noqa: BLE001
                    issues.append(Issue("warning", None, f"DBLP lookup failed: {exc}"))
            if title and match is None and scholar is not None:
                try:
                    match = scholar.lookup(title, e.fields.get("author", ""))
                    if match:
                        source = "scholar"
                except Exception as exc:  # noqa: BLE001
                    issues.append(Issue("warning", None, f"Scholar lookup failed: {exc}"))
            rewritten = rewrite(e, match.to_normalized() if match else None)
            out.append(AuditedEntry(e, issues, match, source, rewritten))
    finally:
        if scholar is not None:
            scholar.__exit__(None, None, None)
    return out


def render_report(audited: list[AuditedEntry]) -> str:
    lines: list[str] = ["# bib-check report", ""]
    for a in audited:
        e = a.entry
        lines.append(f"## [{e.index}] `{e.cite_key}` (line {e.line_number})")
        lines.append("")
        # Hide info-level "field will be stripped" notes — those are merely
        # describing the normalization actions and pollute the report.
        visible = [i for i in a.issues if i.severity in ("error", "warning")]
        if visible:
            lines.append("**Issues**")
            for iss in visible:
                tag = {"error": "❌", "warning": "⚠️"}.get(iss.severity, "-")
                fld = f"`{iss.field}`: " if iss.field else ""
                lines.append(f"- {tag} {fld}{iss.message}")
            lines.append("")
        else:
            lines.append("_No issues detected._\n")

        lines.append("**Original**")
        lines.append("```bibtex")
        lines.append(e.raw.strip())
        lines.append("```")

        if a.match:
            s = a.match
            lines.append(f"**Match (source: {a.source})**")
            lines.append(
                f"- title: {s.title}\n"
                f"- authors ({len(s.authors)}): "
                f"{', '.join(s.authors) if s.authors else '(none)'}\n"
                f"- year: {s.year or '?'}\n"
                f"- venue: {s.venue or '?'} ({s.venue_kind or '?'})\n"
                f"- volume/number/pages: "
                f"{s.volume or '-'} / {s.number or '-'} / {s.pages or '-'}\n"
                f"- meta: `{s.raw_meta}`"
            )
            if s.raw_bibtex:
                lines.append("")
                lines.append("_Raw BibTeX:_")
                lines.append("```bibtex")
                lines.append(s.raw_bibtex)
                lines.append("```")
        else:
            lines.append("_No match found (OpenAlex/DBLP/Scholar all empty or skipped)._")

        lines.append("")
        lines.append("**Rewritten (suggested)**")
        lines.append("```bibtex")
        lines.append(a.rewritten)
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def render_bib(audited: list[AuditedEntry]) -> str:
    return "\n\n".join(a.rewritten for a in audited) + "\n"
