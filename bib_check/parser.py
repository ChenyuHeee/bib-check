"""Minimal BibTeX parser tailored for bib-check.

We re-implement parsing here (rather than depending on bibtexparser) because
the existing repo already uses a hand-rolled parser and we want to mirror its
semantics for line numbers and 1-indexed entry positions.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class BibEntry:
    cite_key: str
    entry_type: str
    fields: dict[str, str] = field(default_factory=dict)
    line_number: int = 0
    index: int = 0  # 1-indexed position in source file
    raw: str = ""  # original text including @type{...} ... }


def parse(filepath: str | Path) -> list[BibEntry]:
    text = Path(filepath).read_text(encoding="utf-8")
    # Strip line comments only when % starts a line; keep % inside braces.
    # Keeping it simple: drop lines starting with % (rare in main.bib).
    cleaned = re.sub(r"^%.*$", "", text, flags=re.MULTILINE)

    entries: list[BibEntry] = []
    header_re = re.compile(r"@(\w+)\s*\{([^,\s]+)\s*,", re.MULTILINE)
    for idx, m in enumerate(header_re.finditer(cleaned), start=1):
        entry_type = m.group(1).lower()
        if entry_type in {"comment", "string", "preamble"}:
            continue
        cite_key = m.group(2).strip()
        body_start = m.end()
        # Find matching closing brace for the @-entry.
        depth = 1
        j = body_start
        while j < len(cleaned) and depth > 0:
            c = cleaned[j]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = cleaned[body_start:j]
        fields = _parse_fields(body)
        line_number = cleaned[: m.start()].count("\n") + 1
        raw = cleaned[m.start() : j + 1]
        entries.append(
            BibEntry(
                cite_key=cite_key,
                entry_type=entry_type,
                fields=fields,
                line_number=line_number,
                index=idx,
                raw=raw,
            )
        )
    return entries


def _parse_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    field_re = re.compile(r"(\w+)\s*=\s*", re.MULTILINE)
    matches = list(field_re.finditer(body))
    for i, m in enumerate(matches):
        name = m.group(1).lower()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        chunk = body[start:end].strip()
        value = _extract_value(chunk)
        if value is not None:
            fields[name] = _normalize_whitespace(value)
    return fields


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
    # bare value
    return chunk.rstrip(",").rstrip("}").strip()


def _normalize_whitespace(value: str) -> str:
    # Collapse internal newlines + runs of spaces; preserve braces/diacritics.
    value = re.sub(r"\s+", " ", value)
    return value.strip().rstrip(",").strip()
