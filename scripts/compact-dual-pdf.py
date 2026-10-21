#!/usr/bin/env python3
"""Reduce the duplicated inner margins of a side-by-side BabelDOC PDF."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def load_pymupdf():
    portable_root = Path(sys.executable).resolve().parents[1]
    sys.path.insert(0, str(portable_root / "site-packages"))
    import pymupdf  # type: ignore

    return pymupdf


def _whitespace_trim(pymupdf, page, requested: float, half_width: float) -> float:
    """How much inner margin can be removed without cutting into content.

    BabelDOC places two full pages side by side, so the gutter between them is
    just the two facing page margins. A fixed trim (the old behaviour) silently
    clipped the first character of every line whenever a document used narrower
    margins than the preset, so measure the real blank gutter instead.
    """
    try:
        pixmap = page.get_pixmap(dpi=72, colorspace=pymupdf.csGRAY)
    except Exception:
        return requested
    width_px, height_px = pixmap.width, pixmap.height
    if width_px < 2 or height_px < 2:
        return requested
    half_px = width_px / 2
    stride = pixmap.stride
    samples = pixmap.samples
    dark_threshold = 244

    def column_has_ink(x_px: int) -> bool:
        for y_px in range(0, height_px, 3):
            if samples[y_px * stride + x_px] < dark_threshold:
                return True
        return False

    # Distance from the gutter outward on each side, i.e. how much blank space
    # borders the seam. Stop at the first column that holds any ink.
    left_gap = 0.0
    x = int(half_px) - 1
    while x >= 0:
        if column_has_ink(x):
            break
        left_gap += 1.0
        x -= 1
    right_gap = 0.0
    x = int(half_px)
    while x < width_px:
        if column_has_ink(x):
            break
        right_gap += 1.0
        x += 1

    # 1 px == 1 pt at 72 dpi; keep a 2 pt safety margin so anti-aliased glyph
    # edges and hairline rules are never touched.
    available = min(left_gap, right_gap) - 2.0
    if available <= 0:
        return 0.0
    return min(requested, available)


def compact(input_path: Path, output_path: Path, trim_points: float) -> None:
    pymupdf = load_pymupdf()
    source = pymupdf.open(input_path)
    destination = pymupdf.open()
    try:
        for page_number, source_page in enumerate(source):
            width = source_page.rect.width
            height = source_page.rect.height
            half_width = width / 2
            trim = min(max(0.0, trim_points), half_width * 0.2)
            if width >= height * 1.2 and trim > 0:
                trim = _whitespace_trim(pymupdf, source_page, trim, half_width)
            if width < height * 1.2 or trim <= 0:
                page = destination.new_page(width=width, height=height)
                page.show_pdf_page(page.rect, source, page_number)
                continue

            compact_half = half_width - trim
            page = destination.new_page(width=width - 2 * trim, height=height)
            left_clip = pymupdf.Rect(0, 0, compact_half, height)
            right_clip = pymupdf.Rect(half_width + trim, 0, width, height)
            page.show_pdf_page(
                pymupdf.Rect(0, 0, compact_half, height),
                source,
                page_number,
                clip=left_clip,
                keep_proportion=False,
            )
            page.show_pdf_page(
                pymupdf.Rect(compact_half, 0, width - 2 * trim, height),
                source,
                page_number,
                clip=right_clip,
                keep_proportion=False,
            )

        destination.set_metadata(source.metadata)
        if table_of_contents := source.get_toc():
            destination.set_toc(table_of_contents)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        destination.save(output_path, garbage=4, deflate=True)
    finally:
        destination.close()
        source.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("output_pdf", type=Path)
    parser.add_argument("--trim-points", type=float, default=80.0)
    args = parser.parse_args()
    compact(args.input_pdf, args.output_pdf, args.trim_points)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
