#!/usr/bin/env python3
"""Spanish handwriting evaluation harness for Caelestia-Ink (format ocr-eval/1).

Purpose: compare recognition models on the same handwritten Spanish samples without the
harness knowing anything about a model. Every model reads the same manifest and writes the
same predictions file, so a report is comparable across engines and runs.

Dataset (JSONL, one object per line)
    {"id": "s001",
     "text": "Ecuación de la recta, ¿verdad?",
     "strokes": [[[x, y], ...], ...],          # vector strokes, canvas pixels
     "canvas": [800, 600],                     # optional
     "source": "board-2026-11-17.blackboard",   # optional, provenance only
     "tags": ["clase", "tilde"]}                # optional, free-form

The `text` field is the human transcription (ground truth). Use plain Markdown for
formatting: *cursiva* for italics. Do not store model output here.

Predictions (JSONL, one object per line)
    {"id": "s001", "text": "Ecuación de la recta, ¿verdad?"}

Optional per-sample fields a model may add: `duration_ms`, `peak_rss_kb`. The harness also
measures wall time and child peak RSS itself, so a model that reports nothing still gets
timing and resource numbers.

Commands
    export  dataset.jsonl -> out/samples/<id>.svg + out/manifest.jsonl
    run     dataset.jsonl + predictor command -> predictions.jsonl (timed)
    score   dataset.jsonl + predictions.jsonl -> report.json (CER/WER + features)
    all     export + run + score in one directory

The harness never invents a prediction: a sample with no prediction is counted as an empty
string and reported in `missing`.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import resource
import shlex
import statistics
import subprocess
import sys
import time
from pathlib import Path

FORMAT = "ocr-eval/1"

ACCENTS = set("áéíóúüÁÉÍÓÚÜ")
ENYES = set("ñÑ")
PUNCTUATION = set(",.;:!?¿¡\"'()«»—…")
ITALIC = re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)")


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"{path}:{number}: JSON inválido: {error}") from error
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{number}: cada línea debe ser un objeto")
            rows.append(row)
    return rows


def require_samples(rows: list[dict], path: Path) -> list[dict]:
    seen = set()
    for index, row in enumerate(rows, 1):
        for field in ("id", "text", "strokes"):
            if field not in row:
                raise SystemExit(f"{path}:{index}: falta '{field}'")
        if not isinstance(row["text"], str):
            raise SystemExit(f"{path}:{index}: 'text' debe ser texto")
        if not isinstance(row["strokes"], list) or not row["strokes"]:
            raise SystemExit(f"{path}:{index}: 'strokes' debe ser una lista no vacía")
        if row["id"] in seen:
            raise SystemExit(f"{path}:{index}: id duplicado {row['id']!r}")
        seen.add(row["id"])
    return rows


def svg_for(sample: dict) -> str:
    strokes = sample["strokes"]
    points = [point for stroke in strokes for point in stroke]
    if not points:
        raise SystemExit(f"{sample['id']}: no tiene puntos")
    width, height = sample.get("canvas") or [0, 0]
    if not width or not height:
        width = max(point[0] for point in points) + 20
        height = max(point[1] for point in points) + 20
    paths = []
    for stroke in strokes:
        if len(stroke) == 1:
            x, y = stroke[0][:2]
            paths.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="1.2" fill="#111"/>')
            continue
        start = stroke[0]
        commands = [f"M {start[0]:.2f} {start[1]:.2f}"]
        commands += [f"L {point[0]:.2f} {point[1]:.2f}" for point in stroke[1:]]
        paths.append(
            f'<path d="{" ".join(commands)}" fill="none" stroke="#111" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" '
        f'viewBox="0 0 {width:.0f} {height:.0f}"><rect width="100%" height="100%" fill="#fff"/>'
        f'{"".join(paths)}</svg>\n'
    )


def export_samples(samples: list[dict], out: Path) -> Path:
    folder = out / "samples"
    folder.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as manifest:
        for sample in samples:
            svg_path = folder / f"{sample['id']}.svg"
            svg_path.write_text(svg_for(sample), encoding="utf-8")
            entry = {
                "id": sample["id"],
                "text": sample["text"],
                "image": str(svg_path.relative_to(out)),
                "tags": sample.get("tags", []),
            }
            manifest.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return manifest_path


def normalize(text: str) -> str:
    """Score the text, not its encoding details: collapse whitespace but keep accents,
    ñ and punctuation, because those are precisely what a Spanish model must get right."""
    return re.sub(r"\s+", " ", text).strip()


def edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        current = [i]
        for j, char_b in enumerate(b, 1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (char_a != char_b))
            )
        previous = current
    return previous[-1]


def feature_recall(reference: str, hypothesis: str, alphabet: set[str]) -> dict:
    """Share of the reference's characters from `alphabet` that the model reproduced in
    order. A model that turns «niño» into «nino» scores 0 for the ñ, even if CER stays low."""
    expected = [char for char in reference if char in alphabet]
    if not expected:
        return {"expected": 0, "matched": 0, "recall": None}
    produced = [char for char in hypothesis if char in alphabet]
    matcher = difflib.SequenceMatcher(a=expected, b=produced, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    return {"expected": len(expected), "matched": matched, "recall": matched / len(expected)}


def italic_spans(text: str) -> list[str]:
    spans = []
    for match in ITALIC.finditer(text):
        spans.append(match.group(1) if match.group(1) is not None else match.group(2))
    return spans


def score_samples(samples: list[dict], predictions: list[dict], predictor: str | None) -> dict:
    by_id = {}
    for row in predictions:
        if not isinstance(row, dict) or "id" not in row:
            raise SystemExit("cada predicción debe ser un objeto con 'id'")
        if "text" in row and not isinstance(row["text"], str):
            raise SystemExit(f"predicción {row['id']!r}: 'text' debe ser texto")
        by_id[row["id"]] = row

    rows = []
    missing = []
    cer_values = []
    wer_values = []
    durations = []
    peak_rss = None
    accents = {"expected": 0, "matched": 0}
    enyes = {"expected": 0, "matched": 0}
    punctuation = {"expected": 0, "matched": 0}
    italic = {"expected": 0, "matched": 0}

    for sample in samples:
        prediction = by_id.get(sample["id"])
        if prediction is None:
            missing.append(sample["id"])
        hypothesis = normalize((prediction or {}).get("text", ""))
        reference = normalize(sample["text"])
        distance = edit_distance(hypothesis, reference)
        cer = distance / max(1, len(reference))
        reference_words = reference.split()
        hypothesis_words = hypothesis.split()
        word_distance = edit_distance_seq(hypothesis_words, reference_words)
        wer = word_distance / max(1, len(reference_words))
        cer_values.append(cer)
        wer_values.append(wer)

        for name, alphabet, bucket in (
            ("accents", ACCENTS, accents),
            ("enye", ENYES, enyes),
            ("punctuation", PUNCTUATION, punctuation),
        ):
            result = feature_recall(reference, hypothesis, alphabet)
            bucket["expected"] += result["expected"]
            bucket["matched"] += result["matched"]

        expected_spans = italic_spans(reference)
        produced_spans = italic_spans(hypothesis)
        matcher = difflib.SequenceMatcher(a=expected_spans, b=produced_spans, autojunk=False)
        italic["expected"] += len(expected_spans)
        italic["matched"] += sum(
            block.size for block in matcher.get_matching_blocks() if block.size
        )

        duration = (prediction or {}).get("duration_ms")
        if isinstance(duration, (int, float)) and duration >= 0:
            durations.append(float(duration))
        reported_rss = (prediction or {}).get("peak_rss_kb")
        if isinstance(reported_rss, (int, float)) and reported_rss >= 0:
            peak_rss = max(peak_rss or 0, int(reported_rss))

        rows.append(
            {
                "id": sample["id"],
                "reference": reference,
                "hypothesis": hypothesis,
                "cer": round(cer, 4),
                "wer": round(wer, 4),
                "duration_ms": duration if isinstance(duration, (int, float)) else None,
            }
        )

    def ratio(bucket: dict) -> float | None:
        return None if bucket["expected"] == 0 else bucket["matched"] / bucket["expected"]

    durations.sort()

    def percentile(values: list[float], fraction: float) -> float | None:
        if not values:
            return None
        index = min(len(values) - 1, max(0, round(fraction * (len(values) - 1))))
        return values[index]

    return {
        "format": FORMAT,
        "predictor": predictor,
        "samples": len(samples),
        "scored": len(samples) - len(missing),
        "missing": missing,
        "cer": {
            "mean": round(statistics.mean(cer_values), 4) if cer_values else None,
            "median": round(statistics.median(cer_values), 4) if cer_values else None,
        },
        "wer": {
            "mean": round(statistics.mean(wer_values), 4) if wer_values else None,
            "median": round(statistics.median(wer_values), 4) if wer_values else None,
        },
        "features": {
            "accents": {"expected": accents["expected"], "matched": accents["matched"], "recall": ratio(accents)},
            "enye": {"expected": enyes["expected"], "matched": enyes["matched"], "recall": ratio(enyes)},
            "punctuation": {
                "expected": punctuation["expected"],
                "matched": punctuation["matched"],
                "recall": ratio(punctuation),
            },
            "italic": {"expected": italic["expected"], "matched": italic["matched"], "recall": ratio(italic)},
        },
        "duration_ms": {
            "samples": len(durations),
            "mean": round(statistics.mean(durations), 1) if durations else None,
            "median": round(statistics.median(durations), 1) if durations else None,
            "p95": None if not durations else round(percentile(durations, 0.95), 1),
            "max": round(durations[-1], 1) if durations else None,
        },
        "resources": {"peak_rss_kb": peak_rss},
        "per_sample": rows,
    }


def edit_distance_seq(a: list[str], b: list[str]) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, item_a in enumerate(a, 1):
        current = [i]
        for j, item_b in enumerate(b, 1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (item_a != item_b))
            )
        previous = current
    return previous[-1]


def run_predictor(command: str, manifest: Path, out: Path) -> tuple[Path, dict]:
    predictions_path = out / "predictions.jsonl"
    started = time.perf_counter()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    completed = subprocess.run(
        [*shlex.split(command), str(manifest), str(predictions_path)],
        check=False,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if completed.returncode != 0:
        raise SystemExit(f"el predictor terminó con código {completed.returncode}")
    if not predictions_path.exists():
        raise SystemExit(f"el predictor no escribió {predictions_path}")
    timing = {
        "wall_ms": round(elapsed_ms, 1),
        "peak_rss_kb": int(max(0, after.ru_maxrss - before.ru_maxrss)),
    }
    return predictions_path, timing


def write_report(report: dict, out: Path) -> Path:
    path = out / "report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluación OCR en español (ocr-eval/1)")
    sub = parser.add_subparsers(dest="command", required=True)

    export_parser = sub.add_parser("export", help="exporta SVG + manifest")
    export_parser.add_argument("--dataset", required=True, type=Path)
    export_parser.add_argument("--out", required=True, type=Path)

    run_parser = sub.add_parser("run", help="ejecuta un predictor externo")
    run_parser.add_argument("--dataset", required=True, type=Path)
    run_parser.add_argument("--out", required=True, type=Path)
    run_parser.add_argument("--predictor", required=True, help="comando; recibe manifest y salida")

    score_parser = sub.add_parser("score", help="calcula CER/WER y rasgos del español")
    score_parser.add_argument("--dataset", required=True, type=Path)
    score_parser.add_argument("--predictions", required=True, type=Path)
    score_parser.add_argument("--out", required=True, type=Path)
    score_parser.add_argument("--predictor", default=None)

    all_parser = sub.add_parser("all", help="export + run + score")
    all_parser.add_argument("--dataset", required=True, type=Path)
    all_parser.add_argument("--out", required=True, type=Path)
    all_parser.add_argument("--predictor", required=True)

    args = parser.parse_args()
    samples = require_samples(read_jsonl(args.dataset), args.dataset)

    if args.command == "export":
        args.out.mkdir(parents=True, exist_ok=True)
        manifest = export_samples(samples, args.out)
        print(manifest)
        return 0

    if args.command == "run":
        args.out.mkdir(parents=True, exist_ok=True)
        manifest = export_samples(samples, args.out)
        predictions, timing = run_predictor(args.predictor, manifest, args.out)
        print(json.dumps({"predictions": str(predictions), **timing}, ensure_ascii=False))
        return 0

    if args.command == "score":
        predictions = read_jsonl(args.predictions)
        report = score_samples(samples, predictions, args.predictor)
        args.out.mkdir(parents=True, exist_ok=True)
        path = write_report(report, args.out)
        print(path)
        return 0

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = export_samples(samples, args.out)
    predictions, timing = run_predictor(args.predictor, manifest, args.out)
    report = score_samples(samples, read_jsonl(predictions), args.predictor)
    report["run"] = timing
    path = write_report(report, args.out)
    print(json.dumps({"report": str(path), **report["cer"], **report["wer"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
