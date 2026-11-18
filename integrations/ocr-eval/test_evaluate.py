#!/usr/bin/env python3
"""Tests for the Spanish OCR harness. Uses synthetic strings and strokes only: they verify
the metrics, not any recognizer."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import evaluate


def sample(sample_id: str, text: str) -> dict:
    return {
        "id": sample_id,
        "text": text,
        "strokes": [[[0, 0], [10, 10], [20, 5]]],
        "canvas": [40, 30],
    }


class MetricsTest(unittest.TestCase):
    def test_edit_distance_counts_substitutions(self):
        self.assertEqual(evaluate.edit_distance("nino", "niño"), 1)
        self.assertEqual(evaluate.edit_distance("", "abc"), 3)
        self.assertEqual(evaluate.edit_distance("igual", "igual"), 0)

    def test_feature_recall_separates_diacritics_from_plain_letters(self):
        result = evaluate.feature_recall("niño, ¿qué tal?", "nino, que tal?", evaluate.ENYES)
        self.assertEqual(result["expected"], 1)
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["recall"], 0.0)

        result = evaluate.feature_recall("Ecuación", "Ecuacion", evaluate.ACCENTS)
        self.assertEqual(result["expected"], 1)
        self.assertEqual(result["matched"], 0)

        result = evaluate.feature_recall("¿Verdad?", "¿Verdad?", evaluate.PUNCTUATION)
        self.assertEqual(result["expected"], 2)
        self.assertEqual(result["matched"], 2)

    def test_italic_spans_read_markdown(self):
        self.assertEqual(evaluate.italic_spans("*cursiva* y normal"), ["cursiva"])
        self.assertEqual(evaluate.italic_spans("_otra_ y *dos*"), ["otra", "dos"])
        self.assertEqual(evaluate.italic_spans("sin formato"), [])

    def test_score_samples_reports_missing_and_per_sample(self):
        samples = [sample("a", "niño"), sample("b", "Ecuación")]
        predictions = [{"id": "a", "text": "niño", "duration_ms": 10}]
        report = evaluate.score_samples(samples, predictions, "prueba")

        self.assertEqual(report["format"], evaluate.FORMAT)
        self.assertEqual(report["samples"], 2)
        self.assertEqual(report["scored"], 1)
        self.assertEqual(report["missing"], ["b"])
        self.assertEqual(report["per_sample"][0]["cer"], 0.0)
        self.assertEqual(report["per_sample"][1]["hypothesis"], "")
        self.assertEqual(report["features"]["enye"]["recall"], 1.0)
        self.assertEqual(report["duration_ms"]["median"], 10)


class ExportTest(unittest.TestCase):
    def test_export_writes_svg_and_manifest_without_model_output(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            manifest = evaluate.export_samples([sample("a", "¿Qué tal?")], out)
            rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines()]

            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], "a")
            self.assertEqual(rows[0]["text"], "¿Qué tal?")
            svg = (out / rows[0]["image"]).read_text(encoding="utf-8")
            self.assertIn("<svg", svg)
            self.assertIn("<path", svg)
            self.assertNotIn("hipótesis", svg)


if __name__ == "__main__":
    unittest.main()
