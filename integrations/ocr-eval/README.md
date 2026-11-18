# Evaluación OCR en español

Arnés neutral respecto al modelo. Todos los motores leen el mismo `manifest.jsonl` y
escriben el mismo `predictions.jsonl`, así que los informes son comparables. El arnés no
reconoce nada por sí mismo ni rellena huecos: si un modelo no predice una muestra, cuenta
como cadena vacía y aparece en `missing`.

Formato: `ocr-eval/1`. Solo usa la biblioteca estándar de Python 3.12+.

## Conjunto de datos

JSONL, un objeto por línea:

```json
{"id": "s001", "text": "Ecuación de la recta, ¿verdad?", "strokes": [[[12, 40], [40, 42]]], "canvas": [800, 600], "tags": ["clase", "tilde"]}
```

- `text`: transcripción humana (verdad de referencia). Markdown admite `*cursiva*`.
- `strokes`: trazos vectoriales en píxeles del lienzo. No se aceptan imágenes como única
  fuente: el SVG exportado sale de aquí, de modo que todos los modelos ven lo mismo.
- `tags`: libre, solo para filtrar o documentar.
- No guardes nunca la salida de un modelo en `text`.

## Uso

```bash
# Exportar SVG + manifest para cualquier modelo de imagen
python integrations/ocr-eval/evaluate.py export \
  --dataset muestra.jsonl --out /tmp/ocr-eval

# Ejecutar un modelo externo: recibe <manifest> <predictions.jsonl>
python integrations/ocr-eval/evaluate.py run \
  --dataset muestra.jsonl --out /tmp/ocr-eval \
  --predictor "python mi_modelo.py"

# Puntuar predicciones ya generadas
python integrations/ocr-eval/evaluate.py score \
  --dataset muestra.jsonl --predictions /tmp/ocr-eval/predictions.jsonl \
  --out /tmp/ocr-eval --predictor "mi-modelo 1.2"
```

`all` hace las tres cosas y añade el tiempo de pared y el pico de RSS del proceso hijo al
informe. `run` mide además el tiempo total; un modelo puede añadir `duration_ms` y
`peak_rss_kb` por muestra.

## Predicciones

```json
{"id": "s001", "text": "Ecuación de la recta, ¿verdad?", "duration_ms": 84, "peak_rss_kb": 412000}
```

Campos obligatorios: `id` y `text`. `duration_ms` y `peak_rss_kb` son opcionales; si faltan,
el informe deja esos agregados en `null` en lugar de inventarlos.

## Informe

`report.json` incluye:

- `cer` y `wer` (media y mediana), calculados sobre texto normalizado en espacios pero
  conservando tildes, ñ y puntuación.
- `features.accents`, `features.enye`, `features.punctuation`: cobertura de esos caracteres
  en la referencia mediante alineamiento ordenado. «nino» por «niño» baja la cobertura de
  ñ aunque el CER global sea pequeño.
- `features.italic`: comparación de los tramos `*…*` / `_…_`.
- `duration_ms`: media, mediana, p95 y máximo.
- `resources.peak_rss_kb`.
- `per_sample`: referencia, hipótesis, CER, WER y duración de cada muestra.

## Reglas

- No se comparan motores con conjuntos distintos ni con transcripciones distintas.
- Una muestra sin predicción no se descarta en silencio: baja el CER y se lista en `missing`.
- El arnés no ejecuta comandos desde el conjunto de datos; `--predictor` lo elige quien
  evalúa.
