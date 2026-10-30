#!/usr/bin/env python3
# Copyright 2026 Arm Limited
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Build the extension's icon font from its 16 x 16 glyph SVG.

    python3 scripts/icon-font/build_icon_font.py

reads assets/icons/cda-robot.svg and writes assets/icons/cda-icons.woff: one
glyph, "cda-robot" at U+E001, which package.json contributes as the product
icon cda-robot, so the status bar can show `$(cda-robot)` (issue #87). Needs
Python 3 with fontTools (`pip install fonttools`); the output is committed, so
only a change of the SVG needs a rebuild.

The SVG is drawn on the 16-px grid the status bar uses: viewBox 0 0 16 16,
filled <path> outlines only (no strokes, shapes or transforms), every subpath
closed, and the even-odd rule: a contour inside an odd number of others is a
hole. Contours must not cross. The font keeps that grid: 64 units per pixel,
the em box is the 16 x 16 design, ascent = units per em and descent 0 like the
codicon font, so `font: 16px/1` puts the glyph where the SVG draws it.
"""
import argparse
import os
import re
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampFromString
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

UPM = 1024                  # 64 units per design pixel: .5 and .25 px stay whole numbers
FAMILY = 'cda-icons'
GLYPH = 'cda-robot'
CODE_POINT = 0xE001
# A fixed date, so that the same SVG always gives the same bytes.
BUILD_DATE = timestampFromString('Mon Oct 19 00:00:00 2026')
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UNSUPPORTED = ('<rect', '<circle', '<ellipse', '<line', '<polyline', '<polygon', 'stroke=', 'transform=')


def contours_of(svg_text):
    """The closed contours of every <path>, in font units with y up, as recorded pen operations."""
    view = re.search(r'viewBox="([^"]+)"', svg_text)
    if not view:
        raise SystemExit('the SVG has no viewBox')
    minx, miny, width, height = (float(v) for v in view.group(1).replace(',', ' ').split())
    if abs(width - height) > 1e-9:
        raise SystemExit(f'the viewBox must be square, it is {width} x {height}')
    for bad in UNSUPPORTED:
        if bad in svg_text:
            raise SystemExit(f'unsupported in the glyph SVG: {bad} (draw filled <path> outlines only)')
    scale = UPM / width
    recording = RecordingPen()
    pen = TransformPen(recording, (scale, 0, 0, -scale, -minx * scale, UPM + miny * scale))
    paths = re.findall(r'<path\b[^>]*\sd="([^"]+)"', svg_text)
    if not paths:
        raise SystemExit('no <path d="..."> in the SVG')
    for d in paths:
        parse_path(d, pen)
    contours, current = [], []
    for op, args in recording.value:
        current.append((op, args))
        if op == 'endPath':
            raise SystemExit('open subpath in the glyph SVG: close every subpath with Z')
        if op == 'closePath':
            contours.append(current)
            current = []
    if current:
        raise SystemExit('a subpath is not closed with Z')
    return contours


def polygon(contour, steps=16):
    """The contour as a polygon, its curves sampled; for the area and the nesting test."""
    points, last = [], None
    for op, args in contour:
        if op in ('moveTo', 'lineTo'):
            last = args[0]
            points.append(last)
        elif op == 'curveTo':
            p0, (p1, p2, p3) = last, args
            for i in range(1, steps + 1):
                t = i / steps
                u = 1 - t
                points.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
            last = p3
        elif op == 'qCurveTo':
            p0, (*offs, p2) = last, args
            p1 = offs[0] if offs else p0
            for i in range(1, steps + 1):
                t = i / steps
                u = 1 - t
                points.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
            last = p2
    return points


def signed_area(poly):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1])) / 2


def encloses(poly, point):
    x, y = point
    hit = False
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def on_contour(poly):
    """A point on the contour; since contours do not cross, another contour holds it exactly when it encloses this one."""
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        if (x0, y0) != (x1, y1):
            return ((x0 + x1) / 2, (y0 + y1) / 2)
    return poly[0]


def glyph_of(contours):
    """The TrueType glyph: contours wound for nonzero filling with the even-odd meaning (outer clockwise, holes counter-clockwise)."""
    polys = [polygon(c) for c in contours]
    pen = TTGlyphPen(None)
    quadratic = Cu2QuPen(pen, max_err=1.0, reverse_direction=False)
    for i, contour in enumerate(contours):
        depth = sum(1 for j, poly in enumerate(polys) if j != i and encloses(poly, on_contour(polys[i])))
        hole = depth % 2 == 1
        clockwise = signed_area(polys[i]) < 0          # y up: a negative area runs clockwise
        target = ReverseContourPen(quadratic) if clockwise == hole else quadratic
        for op, args in contour:
            getattr(target, op)(*args)
    return pen.glyph()


def build(svg_path, woff_path):
    glyph = glyph_of(contours_of(open(svg_path, encoding='utf-8').read()))
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(['.notdef', GLYPH])
    fb.setupCharacterMap({CODE_POINT: GLYPH})
    fb.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), GLYPH: glyph})
    built = fb.font['glyf'][GLYPH]
    built.recalcBounds(fb.font['glyf'])
    # The left side bearing must equal the outline's xMin: TrueType renderers place the outline by it.
    fb.setupHorizontalMetrics({'.notdef': (UPM, 0), GLYPH: (UPM, built.xMin)})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({'familyName': FAMILY, 'styleName': 'Regular', 'version': 'Version 1.000'})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=UPM, usWinDescent=0, fsSelection=0x40)
    fb.setupPost()
    fb.setupHead(unitsPerEm=UPM, created=BUILD_DATE, modified=BUILD_DATE, fontRevision=1.0)
    fb.font.flavor = 'woff'
    fb.font.save(woff_path, reorderTables=True)
    return built


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--svg', default=os.path.join(ROOT, 'assets', 'icons', 'cda-robot.svg'))
    parser.add_argument('--out', default=os.path.join(ROOT, 'assets', 'icons', 'cda-icons.woff'))
    args = parser.parse_args()
    built = build(args.svg, args.out)
    print(f'{args.out}: {GLYPH} at U+{CODE_POINT:04X}, {built.numberOfContours} contours, {os.path.getsize(args.out)} bytes')


if __name__ == '__main__':
    sys.exit(main())
