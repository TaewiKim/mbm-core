#!/usr/bin/env python
"""Convert a hand-authored SVG to PDF + PNG without native libs (svglib + reportlab + poppler).

Fallback converter for environments without rsvg-convert. Registers the DejaVu Sans family
(shipped with matplotlib) so Greek (sigma/tau) and other Unicode glyphs render; the source SVG
must use font-family="DejaVuSans" / "DejaVuSans-Bold" / "DejaVuSans-Oblique" (not font-weight,
which svglib mis-falls-back to a missing Symbol font for non-Latin characters).

Usage: python tools/svg_to_pdf_png.py <in.svg> <out.pdf> <out.png> [png_dpi]
"""
import os
import subprocess
import sys

import matplotlib
from reportlab.graphics import renderPDF
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from svglib.svglib import svg2rlg

_FONT_DIR = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
for _name, _file in [
    ("DejaVuSans", "DejaVuSans.ttf"),
    ("DejaVuSans-Bold", "DejaVuSans-Bold.ttf"),
    ("DejaVuSans-Oblique", "DejaVuSans-Oblique.ttf"),
    ("DejaVuSans-BoldOblique", "DejaVuSans-BoldOblique.ttf"),
]:
    pdfmetrics.registerFont(TTFont(_name, os.path.join(_FONT_DIR, _file)))
pdfmetrics.registerFontFamily(
    "DejaVuSans", normal="DejaVuSans", bold="DejaVuSans-Bold",
    italic="DejaVuSans-Oblique", boldItalic="DejaVuSans-BoldOblique",
)


def convert(src, pdf, png, dpi=300):
    drawing = svg2rlg(src)
    if drawing is None:
        raise SystemExit("svg2rlg returned no drawing for " + src)
    renderPDF.drawToFile(drawing, pdf)
    subprocess.run(["pdftoppm", "-png", "-r", str(dpi), "-singlefile", pdf, png[:-4]], check=True)
    print("wrote", pdf, "and", png)


if __name__ == "__main__":
    a = sys.argv[1:]
    convert(a[0], a[1], a[2], int(a[3]) if len(a) > 3 else 300)
