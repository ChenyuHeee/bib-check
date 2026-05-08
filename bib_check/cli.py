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
    "--skip-scholar",
    is_flag=True,
    help="Run local checks only; do not query Google Scholar.",
)
def audit_cmd(
    bib_file: Path,
    range_spec: str | None,
    keys: str | None,
    out_dir: Path,
    headless: bool,
    skip_scholar: bool,
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
        skip_scholar=skip_scholar,
    )
    if not audited:
        click.echo("No entries matched the selection.", err=True)
        raise SystemExit(1)

    (out_dir / "report.md").write_text(render_report(audited), encoding="utf-8")
    (out_dir / "suggested.bib").write_text(render_bib(audited), encoding="utf-8")
    click.echo(f"Audited {len(audited)} entries.")
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
