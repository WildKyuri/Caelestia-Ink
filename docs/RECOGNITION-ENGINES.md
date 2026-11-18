---
title: Caelestia-Ink — Evaluación de motores de reconocimiento
status: en curso
date: 2026-11-17
cssclasses: [daily, oceano, medium-font]
---

# Evaluación de motores de reconocimiento

## Alcance y criterio

Revisión realizada el 2026-11-16; ampliada el 2026-11-17 con modelos de texto español y una
ejecución real de mathnote-ocr. “Viable” no significa “adoptado”: los resultados actuales
solo justifican una integración experimental, editable y con fallback SVG.

La exportación ya separa contenido y diagnóstico: las regiones de texto, matemáticas y tablas se guardan como Markdown/LaTeX, y solo los gráficos o las regiones pendientes conservan un SVG. El motor simulado queda limitado a compilaciones de desarrollo.

Criterios:

- licencia del código y de los pesos;
- ejecución local y offline;
- Linux;
- entrada por trazos o imagen;
- idioma y dominio de entrenamiento;
- costo de integración y ejecución;
- encaje directo en Obsidian o necesidad de servicio auxiliar.

Quedan excluidos MyScript iink, MathPix y cualquier servicio obligatorio con API remota, suscripción o cuota. La mención de MathPix en la revisión de TeXForm documenta por qué ese camino no se adopta.

## Resumen

| Proyecto | Función | Licencia verificada | Ejecución | Veredicto actual |
| --- | --- | --- | --- | --- |
| ink-on | imagen matemática → LaTeX | código Apache-2.0; pesos sin licencia aclarada | Worker web | No adoptar mientras siga la ambigüedad de pesos |
| mathnote-ocr | trazos matemáticos → árbol/LaTeX | repositorio Apache-2.0; pesos incluidos sin declaración separada | Python/PyTorch CPU | Mejor candidato para primer experimento matemático |
| PaddleOCR.js | imagen → líneas de texto y cajas | código Apache-2.0; confirmar licencia de cada modelo seleccionado | Worker web | Candidato experimental directo para texto |
| PaddleOCR / PP-StructureV3 | OCR, layout y Markdown | código Apache-2.0; verificar cada artefacto | servicio Python | Candidato de estructura, no dependencia mínima |
| PaddleOCR-VL-1.6 | página → texto/fórmulas/tablas/layout | modelo y código marcados Apache-2.0 | servicio Python/Paddle o Transformers | Experimento posterior de página completa |
| microsoft/trocr-base-handwritten | imagen de línea → texto | pesos marcados MIT | servicio Python/PyTorch | Baseline en inglés; no selección para español |
| ifesther/trocr-spanish-handwritten | imagen de línea → texto español | pesos MIT | servicio Python/PyTorch | Primer baseline español; entrenado con fuentes sintéticas |
| qantev/trocr-large-spanish | imagen → texto impreso español | pesos MIT | servicio Python/PyTorch | Solo referencia para texto impreso, no manuscrito |
| TeXForm | pipeline de página completa | archivo `LICENSE` vacío | FastAPI/Python | Solo referencia; no incorporar código |

## Matemáticas

### ink-on

Repositorio: <https://github.com/kimseungdae/ink-on>

**Qué ofrece**

- Reconocimiento de expresiones matemáticas manuscritas en el navegador.
- Núcleo TypeScript independiente del componente Vue.
- ONNX Runtime Web con WASM/WebGPU y Worker.
- Encoder y decoder INT8 anunciados con un total aproximado de 7.2 MB.
- Salida LaTeX con reparaciones sintácticas básicas.

**Integración**

Es el candidato más sencillo para ejecución dentro del plugin: acepta imagen, no requiere Python y su núcleo es independiente del framework. El adaptador debería recibir un recorte de región, ejecutar en un Worker único compartido y devolver LaTeX, confianza si está disponible y metadatos del modelo.

**Licencia**

- El repositorio y paquete declaran Apache-2.0.
- Los modelos se describen como derivados de CoMER.
- El repositorio oficial de CoMER no publica una licencia en su raíz.
- La incidencia [ink-on #2](https://github.com/kimseungdae/ink-on/issues/2) pregunta expresamente por la licencia de los pesos INT8 y no aporta una aclaración suficiente al momento de esta revisión.

**Veredicto**

Bloqueado para adopción o distribución. Puede estudiarse su interfaz, pero no deben incluirse ni descargarse automáticamente esos pesos hasta contar con autorización explícita y trazable.

### mathnote-ocr

Repositorio: <https://github.com/YonatanNemtsov/mathnote-ocr>

**Qué ofrece**

- Entrada directa como lista de trazos `(x, y)`.
- Salida de expresión con LaTeX, confianza, símbolos y cajas.
- Predicción incremental y corrección mediante subárboles fijados.
- Modelo anunciado de aproximadamente 1.2 M parámetros y ejecución CPU.
- Pesos empaquetados con la biblioteca.

**Instalación y Linux**

- Python 3.10 o superior.
- Dependencias principales: PyTorch 2.4+, torchvision, Pillow, NumPy, PyYAML y ziamath.
- La instalación PyTorch genérica en Linux puede descargar componentes CUDA grandes. Para un perfil CPU debe instalarse primero la variante oficial CPU y después el paquete.

**Integración**

Necesita un servicio auxiliar Python. Encaja bien con los datos de Blackboard porque evita rasterizar matemáticas y conserva agrupaciones por trazo. El adaptador debe normalizar escala y origen sin alterar el orden de trazos.

**Licencia**

El repositorio, `pyproject.toml` y paquete declaran Apache-2.0, y los pesos viven dentro del repositorio/paquete. No se encontró una licencia separada ni un inventario de procedencia para los pesos; antes de redistribuirlos debe pedirse confirmación de que quedan cubiertos por Apache-2.0 y revisar datasets de entrenamiento.

**Veredicto**

Candidato prioritario para una prueba matemática local. No seleccionarlo como dependencia hasta completar prueba de calidad, empaquetado CPU, latencia y aclaración de pesos.

**Ejecución real e integración**

- Entorno aislado: CPython 3.12.16, PyTorch 2.15.0+cpu, torchvision 0.29.2+cpu y
  mathnote-ocr 0.2.1; 924 MB en disco.
- Sidecar: protocolo 1 por stdin/stdout, fuente Python embebida en el bundle, sin rutas del
  vault, archivos temporales, puertos ni comandos derivados del contenido.
- Entrada: puntos `(x, y)` originales en orden, redondeados a dos decimales. No se cambia
  origen ni escala porque el motor normaliza internamente.
- Política: confianza mínima 0,75 y máximo 15 % de trazos sin explicar. Por debajo, la región
  queda `unknown` y conserva SVG.
- Pizarra real `2/3 = x − y = f`: `\\frac{2}{3} = x - - W -`, confianza 1,0 y 1/13 trazos
  sin explicar. La confianza está sobrecalibrada y la transcripción no es aceptable sin
  corrección manual.
- Texto real «Depende como realizamos el proyecto»: salida matemática incorrecta, confianza
  0,436 y 2 trazos sin explicar; se descarta por el umbral.
- Corpus externo `run_001` (81 expresiones manuscritas, Apache-2.0): exactitud LaTeX canónica
  40,7 %, CER medio 0,277, mediana 48 ms y máximo 2.256 ms después de cargar el proceso.
  Exactitud por grupo: álgebra 100 %, otro 81,8 %, potencia 50 %, fracción 35,7 %, derivada
  30,4 %, raíz 20 % e integral 18,2 %. Son resultados de esta ejecución, no cifras del autor.

Conclusión: utilizable como proveedor experimental con revisión humana; insuficiente para
guardar automáticamente matemáticas reales. La licencia/procedencia separada de los pesos
sigue pendiente antes de redistribuir el entorno.

## Texto y estructura

### PaddleOCR.js oficial

Código: <https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js>

Paquete: `@paddleocr/paddleocr-js`

**Qué ofrece**

- SDK oficial de navegador, TypeScript y Apache-2.0.
- Detección y reconocimiento de texto mediante ONNX Runtime Web y OpenCV.js.
- Entrada `Blob`, `ImageBitmap`, `ImageData`, canvas o imagen DOM.
- Resultado por línea con polígono, texto, puntuación y métricas.
- Modo Worker integrado.
- Modelos PP-OCRv5 y PP-OCRv6 o assets personalizados.

**Requisitos de integración**

- Dependencias del paquete: ONNX Runtime Web, OpenCV.js, Clipper y js-yaml.
- Alojar localmente binarios WASM y archivos de modelo; el fallback de Worker puede usar CDN y no cumple el requisito offline.
- Verificar que esbuild emite el Worker y resuelve sus assets.
- Los hilos WASM/WebGPU pueden requerir condiciones que Obsidian/Electron no garantice; usar WASM sin hilos como fallback.
- La versión 0.4.2 desempaquetada del paquete ronda 24 MB antes de sumar modelos, según el registro npm.

**Limitaciones para este proyecto**

- Es OCR de imagen, no reconocimiento nativo de trazos.
- No ensambla una página Markdown ni separa matemáticas.
- La documentación no demuestra precisión en manuscrito español de stylus.
- La selección `lang`/modelo y la licencia de los assets concretos deben fijarse y auditarse.

**Veredicto**

Mejor candidato para un experimento de texto ejecutado directamente en el plugin. Debe compararse contra un baseline de servicio usando el mismo corpus; no se adopta todavía.

### PaddleOCR Python y PP-StructureV3

Repositorio: <https://github.com/PaddlePaddle/PaddleOCR>

**Qué ofrece**

- PP-OCR para detección y reconocimiento multilingüe.
- PP-StructureV3 para layout, tablas, fórmulas y conversión estructurada a Markdown/JSON.
- Coordenadas más detalladas que la familia PaddleOCR-VL según la documentación del proyecto.
- Ejecución local CPU/GPU en Linux.

**Instalación**

- Python compatible con la versión elegida.
- PaddlePaddle y extras de PaddleOCR/PaddleX según pipeline.
- Descarga automática de varios modelos si no se preaprovisionan.
- La serie 3.x no es compatible en API con código escrito para 2.x; deben fijarse versiones.

**Integración**

Debe aislarse en un servicio local por tamaño, dependencias nativas y tiempo de carga. Es útil como motor de layout o baseline de página, no como código embebido en `main.js`.

**Licencia**

El código principal usa Apache-2.0. La adopción exige registrar la licencia y origen de cada modelo descargado por el pipeline; la licencia general del repositorio no debe extrapolarse sin revisar los artefactos concretos.

**Veredicto**

Candidato para la fase de estructura después de obtener un corpus. PP-StructureV3 debe evaluarse separado de PP-OCR para saber qué componente aporta la mejora.

### PaddleOCR-VL-1.6

Modelo: <https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6>

**Qué ofrece**

- Modelo visual-lingüístico de aproximadamente 0.9 B parámetros.
- Reconocimiento de texto, fórmulas, tablas, gráficos, sellos y text spotting.
- Pipeline oficial capaz de guardar JSON y Markdown.
- Pesos/model card marcados Apache-2.0.

**Instalación y ejecución**

- El método oficial requiere PaddlePaddle 3.2.1+ y `paddleocr[doc-parser]>=3.6.0`.
- La ruta optimizada usa un servidor vLLM/imagen Docker y GPU; también existe ruta nativa y ejemplo con Transformers.
- El ejemplo Transformers puede usar CPU, pero la viabilidad práctica, RAM y latencia no están documentadas para este hardware y deben medirse.
- La propia tarjeta recomienda el pipeline oficial para página completa; el ejemplo Transformers es por elemento o spotting.

**Encaje**

Podría simplificar layout, fórmulas y texto, pero acoplar todo a una sola salida haría más difícil corregir errores o cambiar motores. Debe adaptarse al mismo documento intermedio que los motores especializados.

**Veredicto**

Experimento de fase posterior, ejecutado como servicio. No forma parte de la implementación mínima por peso, instalación y falta de validación específica en manuscrito español.

### microsoft/trocr-base-handwritten

Modelo: <https://huggingface.co/microsoft/trocr-base-handwritten>

**Qué ofrece**

- Encoder-decoder de aproximadamente 333 M parámetros.
- Entrada de imagen y salida de texto.
- Ajustado con IAM, un corpus de manuscrito inglés.
- Uso documentado sobre imágenes de una sola línea.

**Licencia e instalación**

- La tarjeta y metadatos de Hugging Face marcan los pesos como MIT.
- Uso habitual con Python, PyTorch y Transformers.
- Linux es compatible, pero el modelo no debe cargarse dentro del proceso UI de Obsidian.

**Limitaciones**

- No está entrenado específicamente para español.
- No recibe páginas completas ni trazos directamente.
- Requiere segmentación fiable en líneas.
- No reconoce estructura ni matemáticas.

**Veredicto**

Baseline de investigación, no motor recomendado. Solo avanzaría si supera una prueba de manuscrito español; de lo contrario no justifica su costo.

### ifesther/trocr-spanish-handwritten

Modelo: <https://huggingface.co/ifesther/trocr-spanish-handwritten>

**Qué ofrece**

- Ajuste de `microsoft/trocr-base-handwritten` para español moderno.
- Salida de una línea de texto, con tildes, `ñ`, `¿` y `¡`.
- Pesos y modelo base marcados MIT.

**Limitaciones**

- Se entrenó con 3.000 recortes sintéticos generados a partir de 41 fuentes tipográficas, no con manuscrito real de varios escritores.
- El encoder quedó congelado; el ajuste se concentró en el decodificador.
- Requiere segmentación previa en líneas.
- No hay métricas publicadas sobre escritura de stylus en español.

**Veredicto**

Primer baseline español que debe medirse, no una solución validada. Su riesgo principal es que aprendió formas de fuente, no variabilidad humana. Debe compararse contra el modelo base en inglés y contra PaddleOCR con el mismo corpus.

### Texto español: estado de la evidencia

No se encontró un motor open source con precisión demostrada en manuscrito español de pizarra digital. Los candidatos disponibles cubren tres casos distintos:

- TrOCR en inglés: manuscrito real, pero idioma incorrecto.
- TrOCR español: idioma correcto, pero datos sintéticos de imprenta.
- PaddleOCR: texto impreso multilingüe, manuscrito débil.

Por eso la fase de texto debe empezar por el corpus y las métricas, no por adoptar un modelo. `Xenova/trocr-base-handwritten` ofrece ONNX y podría ejecutarse dentro del plugin con transformers.js, pero es inglés y también necesita segmentación de líneas; el ajuste español tendría que exportarse a ONNX y validarse aparte.

## Proyecto de referencia

### TeXForm

Repositorio: <https://github.com/a2105z/TeXForm>

**Arquitectura observada**

```text
imagen/PDF → segmentación de líneas → TrOCR → reconocimiento matemático → documento
```

Usa frontend React/Vite y backend FastAPI. Su backend carga TrOCR de forma diferida, ofrece Pix2Text offline como opción matemática y contempla MathPix comercial.

**Problemas para adopción**

- El archivo `LICENSE` existe pero tiene cero bytes; GitHub no detecta una licencia. Sin licencia, no hay permiso para copiar, modificar o redistribuir su código.
- Incluye una vía opcional comercial que incumple las condiciones de Caelestia-Ink.
- Produce LaTeX/PDF y no resuelve por sí mismo el modelo de recursos y enlaces de Obsidian.
- Sus heurísticas no constituyen evidencia de calidad para español manuscrito.

**Veredicto**

Usar únicamente como referencia conceptual. No copiar código ni convertirlo en dependencia.

## Selección provisional por función

| Función | Primera opción a experimentar | Alternativa | Motivo |
| --- | --- | --- | --- |
| Matemática por trazos | mathnote-ocr | ink-on cuando aclare pesos | aprovecha `Stroke[]` y es pequeño |
| Texto dentro del plugin | PaddleOCR.js | ninguna seleccionada | Worker oficial y salida con cajas |
| Texto manuscrito baseline | TrOCR | PaddleOCR Python | comparación controlada, no adopción |
| Layout de página | heurística propia inicial | PP-StructureV3 | reducir dependencias antes de medir |
| Página completa avanzada | PaddleOCR-VL-1.6 | PP-StructureV3 | experimento posterior, no arquitectura monolítica |
| Gráfico no reconocido | SVG propio | PNG del recorte | fidelidad y modo offline |

No hay ganador para texto español. La decisión se tomará con un benchmark, no con descripciones de proyectos.

## Experimentos obligatorios

### Corpus mínimo

Recolectar muestras con consentimiento y conservar verdad de referencia:

- al menos 30 pizarras reales y 200 líneas;
- varios escritores y estilos;
- español con tildes, `ñ`, signos de apertura y abreviaturas;
- texto con matemática inline y de bloque;
- matrices, fracciones, raíces, superíndices y subíndices;
- listas, títulos, columnas, flechas, diagramas y tachaduras;
- pluma, presión variable y resaltador.

Separar escritores entre ajuste de umbrales y evaluación para no medir memorización.

### Métricas

- Texto: CER y WER, además de exactitud específica de diacríticos.
- Matemáticas: exactitud exacta de LaTeX normalizado y tasa de render equivalente.
- Segmentación: IoU, precisión/recall de regiones y orden de lectura.
- Preservación: porcentaje de regiones inciertas exportadas sin pérdida de trazos.
- Sistema: latencia p50/p95, pico de RAM, tamaño descargado, arranque y cancelación.
- Offline: cero solicitudes de red durante inferencia después del aprovisionamiento.

### Matriz inicial

1. PaddleOCR.js con el modelo latino/multilingüe elegido sobre líneas y regiones.
2. TrOCR sobre las mismas líneas.
3. PaddleOCR Python sobre las mismas regiones.
4. mathnote-ocr con trazos matemáticos originales.
5. PaddleOCR-VL y PP-StructureV3 sobre páginas completas seleccionadas.
6. Pipeline híbrido frente a cada motor monolítico.

## Condiciones antes de adoptar una dependencia

1. Licencia del código documentada.
2. Licencia y procedencia de pesos documentadas por artefacto.
3. Versiones y hashes fijados.
4. Instalación reproducible en Linux.
5. Inferencia offline comprobada.
6. Resultados del corpus publicados en el repositorio.
7. Uso de memoria y latencia dentro del presupuesto acordado.
8. Fallo y cancelación no afectan Blackboard.
9. Desinstalación elimina solo artefactos gestionados por Caelestia-Ink.

## Fuentes principales

- [ink-on README](https://github.com/kimseungdae/ink-on/blob/main/README.md) y [licencia](https://github.com/kimseungdae/ink-on/blob/main/LICENSE)
- [CoMER](https://github.com/Green-Wood/CoMER)
- [mathnote-ocr README](https://github.com/YonatanNemtsov/mathnote-ocr/blob/main/README.md), [pyproject](https://github.com/YonatanNemtsov/mathnote-ocr/blob/main/pyproject.toml) y [licencia](https://github.com/YonatanNemtsov/mathnote-ocr/blob/main/LICENSE)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) y [PaddleOCR.js SDK](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md)
- [PaddleOCR-VL-1.6](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)
- [TrOCR base handwritten](https://huggingface.co/microsoft/trocr-base-handwritten)
- [TrOCR Spanish handwritten](https://huggingface.co/ifesther/trocr-spanish-handwritten)
- [TrOCR large Spanish](https://huggingface.co/qantev/trocr-large-spanish)
- [TrOCR small handwritten ONNX](https://huggingface.co/Xenova/trocr-small-handwritten)
- [Spanish TrOCR paper](https://arxiv.org/html/2407.06950v1)
- [mathnote-ocr en PyPI](https://pypi.org/project/mathnote-ocr/)
- [TeXForm README](https://github.com/a2105z/TeXForm/blob/main/README.md) y [LICENSE vacío](https://github.com/a2105z/TeXForm/blob/main/LICENSE)
