"""Top-level audit pipeline: parse → detect issues → query Scholar → rewrite."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .normalizer import Issue, detect_issues, rewrite
from .parser import BibEntry, parse
from .scholar import ScholarClient, ScholarResult


@dataclass
class AuditedEntry:
    entry: BibEntry
    issues: list[Issue]
    scholar: ScholarResult | None
    rewritten: str


def audit(
    bib_path: str | Path,
    selected_indices: set[int] | None = None,
    selected_keys: set[str] | None = None,
    cache_dir: str | Path = "out/cache",
    headless: bool = False,
    skip_scholar: bool = False,
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

    out: list[AuditedEntry] = []
    if skip_scholar:
        for e in targets:
            issues = detect_issues(e)
            out.append(AuditedEntry(e, issues, None, rewrite(e, None)))
        return out

    with ScholarClient(cache_dir=cache_dir, headless=headless) as sc:
        for e in targets:
            issues = detect_issues(e)
            scholar = None
            title = e.fields.get("title", "")
            if title:
                try:
                    scholar = sc.lookup(title, e.fields.get("author", ""))
                except Exception as exc:  # noqa: BLE001
                    issues.append(Issue("warning", None, f"scholar lookup failed: {exc}"))
            rewritten = rewrite(e, scholar.to_normalized() if scholar else None)
            out.append(AuditedEntry(e, issues, scholar, rewritten))
    return out


def render_report(audited: list[AuditedEntry]) -> str:
    lines: list[str] = ["# bib-check report", ""]
    for a in audited:
        e = a.entry
        lines.append(f"## [{e.index}] `{e.cite_key}` (line {e.line_number})")
        lines.append("")
        if a.issues:
            lines.append("**Issues**")
            for iss in a.issues:
                tag = {"error": "❌", "warning": "⚠️", "info": "ℹ️"}.get(iss.severity, "-")
                fld = f"`{iss.field}`: " if iss.field else ""
                lines.append(f"- {tag} {fld}{iss.message}")
            lines.append("")
        else:
            lines.append("_No issues detected._\n")

        lines.append("**Original**")
        lines.append("```bibtex")
        lines.append(e.raw.strip())
        lines.append("```")

        if a.scholar:
            s = a.scholar
            lines.append("**Google Scholar match**")
            lines.append(
                f"- title: {s.title}\n"
                f"- authors ({len(s.authors)}): "
                f"{', '.join(s.authors) if s.authors else '(none)'}\n"
                f"- year: {s.year or '?'}\n"
                f"- venue: {s.venue or '?'} ({s.venue_kind or '?'})\n"
                f"- volume/number/pages: "
                f"{s.volume or '-'} / {s.number or '-'} / {s.pages or '-'}\n"
                f"- gray meta: `{s.raw_meta}`"
            )
            if s.raw_bibtex:
                lines.append("")
                lines.append("_Raw BibTeX as exported by Scholar:_")
                lines.append("```bibtex")
                lines.append(s.raw_bibtex)
                lines.append("```")
        else:
            lines.append("_No Scholar match used (none found or skipped)._")

        lines.append("")
        lines.append("**Rewritten (suggested)**")
        lines.append("```bibtex")
        lines.append(a.rewritten)
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def render_bib(audited: list[AuditedEntry]) -> str:
    return "\n\n".join(a.rewritten for a in audited) + "\n"
