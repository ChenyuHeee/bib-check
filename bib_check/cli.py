"""bib-check CLI."""
from __future__ import annotations

from pathlib import Path

import click

from .checker import audit, render_bib, render_report


def _parse_range(spec: str | None) -> set[int] | None:
    if not spec:
        return None
    out: set[int] = set()
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, hi = chunk.split("-", 1)
            out.update(range(int(lo), int(hi) + 1))
        else:
            out.add(int(chunk))
    return out


def _parse_keys(spec: str | None) -> set[str] | None:
    if not spec:
        return None
    return {k.strip() for k in spec.split(",") if k.strip()}


@click.group()
def main() -> None:
    """Audit BibTeX entries against Google Scholar."""


@main.command("audit")
@click.argument("bib_file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--range",
    "range_spec",
    default=None,
    help='Entry indices to audit (1-indexed). e.g. "79-119" or "5,7,10-15".',
)
@click.option("--keys", default=None, help="Comma-separated cite keys to audit.")
@click.option(
    "--out-dir",
    type=click.Path(path_type=Path),
    default=Path("out"),
    show_default=True,
    help="Output directory.",
)
@click.option("--headless/--no-headless", default=False, show_default=True)
@click.option(
    "--use-scholar",
    is_flag=True,
    help="Fall back to Google Scholar (Playwright) when DBLP misses. "
         "Off by default because Scholar throttles aggressively.",
)
@click.option(
    "--skip-dblp",
    is_flag=True,
    help="Do not query DBLP.",
)
@click.option(
    "--skip-openalex",
    is_flag=True,
    help="Do not query OpenAlex (primary source).",
)
@click.option(
    "--skip-crossref",
    is_flag=True,
    help="Do not query Crossref.",
)
def audit_cmd(
    bib_file: Path,
    range_spec: str | None,
    keys: str | None,
    out_dir: Path,
    headless: bool,
    use_scholar: bool,
    skip_dblp: bool,
    skip_openalex: bool,
    skip_crossref: bool,
) -> None:
    indices = _parse_range(range_spec)
    key_set = _parse_keys(keys)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = out_dir / "cache"

    audited = audit(
        bib_file,
        selected_indices=indices,
        selected_keys=key_set,
        cache_dir=cache_dir,
        headless=headless,
        use_scholar=use_scholar,
        skip_dblp=skip_dblp,
        skip_openalex=skip_openalex,
        skip_crossref=skip_crossref,
    )
    if not audited:
        click.echo("No entries matched the selection.", err=True)
        raise SystemExit(1)

    (out_dir / "report.md").write_text(render_report(audited), encoding="utf-8")
    (out_dir / "suggested.bib").write_text(render_bib(audited), encoding="utf-8")

    by_source: dict[str, int] = {}
    for a in audited:
        by_source[a.source] = by_source.get(a.source, 0) + 1
    click.echo(f"Audited {len(audited)} entries.")
    for src, n in sorted(by_source.items()):
        click.echo(f"  matched via {src}: {n}")
    click.echo(f"  report:    {out_dir / 'report.md'}")
    click.echo(f"  suggested: {out_dir / 'suggested.bib'}")


@main.command("list")
@click.argument("bib_file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def list_cmd(bib_file: Path) -> None:
    """List entries with their 1-indexed positions."""
    from .parser import parse

    for e in parse(bib_file):
        click.echo(f"{e.index:4d}  {e.entry_type:<14}  {e.cite_key}  (line {e.line_number})")


if __name__ == "__main__":
    main()
