#!/usr/bin/env python3
"""Minimal stdin/stdout bridge for a mathnote-ocr integration probe.

Not used by the plugin yet. It exists to measure mathnote-ocr on the exact stroke data that
Caelestia-Ink already has, before any adapter is written.

Input (stdin, JSON):
    {"strokes": [[[x, y], [x, y], ...], [[x, y], ...]]}

Output (stdout, JSON):
    {"latex": "...", "confidence": 0.0-1.0, "engine": "mathnote-ocr"}

Requires Python 3.10-3.13 and mathnote-ocr installed. See README.md in this folder.
"""

import json
import sys


def fail(message: str) -> "NoReturn":
    print(json.dumps({"error": message}), file=sys.stdout)
    raise SystemExit(2)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"invalid JSON: {error}")

    raw_strokes = payload.get("strokes") if isinstance(payload, dict) else None
    if not isinstance(raw_strokes, list) or not raw_strokes:
        fail("'strokes' must be a non-empty array of point arrays")

    strokes = []
    for index, stroke in enumerate(raw_strokes):
        if not isinstance(stroke, list) or len(stroke) < 2:
            fail(f"stroke {index} must contain at least two points")
        points = []
        for point in stroke:
            if not isinstance(point, list) or len(point) < 2:
                fail(f"stroke {index} has an invalid point")
            points.append((float(point[0]), float(point[1])))
        strokes.append(points)

    try:
        from mathnote_ocr import MathOCR
    except ImportError as error:
        fail(f"mathnote-ocr is not installed: {error}")

    try:
        expression = MathOCR().detect(strokes)
    except Exception as error:  # noqa: BLE001 - the probe reports any engine failure as JSON
        fail(f"mathnote-ocr failed: {error}")

    print(json.dumps({
        "latex": expression.latex,
        "confidence": float(expression.confidence),
        "engine": "mathnote-ocr",
    }))


if __name__ == "__main__":
    main()
