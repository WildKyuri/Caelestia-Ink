#!/usr/bin/env python3
"""mathnote-ocr sidecar for Caelestia-Ink (protocol 1).

Started by the plugin as ``python -c <this source>``. It never receives a path or a
command from the board: every request arrives as one JSON line on stdin and every answer
leaves as one JSON line on stdout. The process is killed by the plugin when the conversion
ends, fails or is cancelled, so it never outlives Obsidian.

Request  (one JSON object per line):
    {"protocol": 1, "op": "detect", "id": "region-001",
     "strokes": [[[x, y], ...], ...]}

Response:
    {"protocol": 1, "id": "region-001", "ok": true, "latex": "...",
     "confidence": 0.93, "symbols": 9, "unexplained": 0, "grouping": 0.87,
     "durationMs": 41}

Other operations: ``{"op": "ping"}`` for a settings check and ``{"op": "shutdown"}``.

The engine is configured with the app's own grammar: two stacked short strokes are read as
one ``=`` (the usual way to write it by hand) and two adjacent operators are rejected.
Nothing here reads or writes files, opens sockets or evaluates input as code.
"""

import json
import sys
import time

PROTOCOL = 1
ENGINE = "mathnote-ocr-0.2.1"
OPERATORS = {"+", "-", "="}
MAX_STROKES = 4000
MAX_POINTS = 60000


def fail(message):
    return {"ok": False, "error": message}


def parse_strokes(raw):
    if not isinstance(raw, list) or not raw:
        return None, "'strokes' must be a non-empty array of strokes"
    total = 0
    strokes = []
    for index, stroke in enumerate(raw):
        if not isinstance(stroke, list) or len(stroke) < 2:
            return None, "stroke %d must contain at least two points" % index
        points = []
        for point in stroke:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                return None, "stroke %d has an invalid point" % index
            x, y = point[0], point[1]
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                return None, "stroke %d has a non-numeric coordinate" % index
            if x != x or y != y:  # NaN
                return None, "stroke %d has a NaN coordinate" % index
            points.append((float(x), float(y)))
        total += len(points)
        if total > MAX_POINTS:
            return None, "region too large: more than %d points" % MAX_POINTS
        strokes.append(points)
    if len(strokes) > MAX_STROKES:
        return None, "region too large: more than %d strokes" % MAX_STROKES
    return strokes, None


def no_two_operators(names, where):
    return [
        index
        for index in range(1, len(names))
        if names[index] in OPERATORS and names[index - 1] in OPERATORS
    ]


def build_engine():
    from mathnote_ocr import Grammar, MathOCR, Rewrite

    grammar = Grammar(no_two_operators, rewrites=[Rewrite(("-", "-"), ("=",))])
    return MathOCR(grammar=grammar)


def main():
    try:
        import torch

        torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    except Exception:  # noqa: BLE001 - the engine still runs without torch tuning
        pass

    engine = None
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            out.write(json.dumps(fail("invalid JSON: %s" % error)) + "\n")
            out.flush()
            continue
        if not isinstance(request, dict):
            out.write(json.dumps(fail("request must be an object")) + "\n")
            out.flush()
            continue

        protocol = request.get("protocol", PROTOCOL)
        if protocol != PROTOCOL:
            out.write(json.dumps(fail("unsupported protocol: %r" % protocol)) + "\n")
            out.flush()
            continue

        operation = request.get("op")
        if operation == "ping":
            out.write(json.dumps({"protocol": PROTOCOL, "ok": True, "engine": ENGINE}) + "\n")
            out.flush()
            continue
        if operation == "shutdown":
            out.write(json.dumps({"protocol": PROTOCOL, "ok": True}) + "\n")
            out.flush()
            return
        if operation != "detect":
            out.write(json.dumps(fail("unknown operation: %r" % operation)) + "\n")
            out.flush()
            continue

        request_id = request.get("id")
        strokes, error = parse_strokes(request.get("strokes"))
        if error:
            answer = fail(error)
            answer.update({"protocol": PROTOCOL, "id": request_id})
            out.write(json.dumps(answer) + "\n")
            out.flush()
            continue

        started = time.perf_counter()
        try:
            if engine is None:
                engine = build_engine()
            expression = engine.detect(strokes)
            grouping = expression.grouping_prob
            answer = {
                "protocol": PROTOCOL,
                "id": request_id,
                "ok": True,
                "engine": ENGINE,
                "latex": expression.latex,
                "confidence": float(expression.confidence),
                "symbols": len(expression.symbols),
                "unexplained": len(expression.unexplained_stroke_ids),
                "grouping": None if grouping is None else float(grouping),
                "durationMs": round((time.perf_counter() - started) * 1000, 1),
            }
        except Exception as error:  # noqa: BLE001 - report every engine failure as JSON
            answer = fail("mathnote-ocr failed: %s" % error)
            answer.update({"protocol": PROTOCOL, "id": request_id})
        out.write(json.dumps(answer) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
