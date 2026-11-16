---
title: Caelestia-Ink — Hoja de ruta de implementación
status: en curso
date: 2026-11-16
cssclasses: [daily, oceano, medium-font]
---

# Hoja de ruta de implementación

## Principio de avance

Cada fase debe terminar con una función comprobable y reversible. No se instalará un motor hasta aprobar sus resultados, licencia y costo. Blackboard debe seguir funcionando aunque todos los módulos de reconocimiento falten o fallen.

## Puertas globales

Toda fase debe cumplir:

1. `npm run check` sin regresiones.
2. Ningún cambio no solicitado en el formato `.blackboard`.
3. Conversión iniciada solo por acción del usuario.
4. Trazos idénticos antes y después de convertir.
5. Cancelación y error sin nota parcial ni recursos huérfanos.
6. Sin red durante inferencia cuando modelos y dependencias ya están instalados.
7. Pruebas en vista completa, embed Markdown, nodo Canvas y ventana desprendida cuando aplique.

## Fase 0 — Corpus, licencias y presupuestos

**Objetivo:** convertir decisiones de motores en experimentos reproducibles.

### Trabajo

- Definir presupuesto máximo de descarga, RAM y latencia para escritorio y móvil.
- Crear corpus anonimizado de español, matemáticas y páginas mixtas.
- Definir verdad de referencia y scripts de métricas fuera del runtime del plugin.
- Registrar versión, URL, hash, licencia de código, licencia de pesos y datasets conocidos por candidato.
- Resolver por escrito la cobertura legal de pesos de mathnote-ocr.
- Mantener ink-on bloqueado hasta aclaración de sus pesos.

### Pruebas

- Validación del esquema del corpus.
- Separación por escritor entre conjuntos.
- Repetición de métricas con entradas idénticas.

### Criterio de aceptación

- El corpus cubre tildes, `ñ`, signos españoles, texto-matemática y gráficos.
- Cada candidato tiene expediente de licencia; lo desconocido figura como bloqueo.
- Los presupuestos están acordados antes de seleccionar motor.

## Fase 1 — Esqueleto sin reconocimiento real

**Objetivo:** probar el flujo completo con motores falsos, sin añadir dependencias de ML.

### Trabajo

1. Definir contratos de snapshot, regiones, motores, documento intermedio y salida.
2. Implementar copia profunda y huella estable del documento activo.
3. Implementar render PNG de alta resolución fuera del canvas visible.
4. Implementar exportación SVG por subconjunto de `strokeIds`.
5. Añadir segmentador determinista simple y motor falso.
6. Generar un borrador Markdown con regiones como texto simulado o SVG.
7. Añadir escritor atómico en una carpeta de prueba configurable.
8. Exponer el caso de uso mediante comando; añadir botón después de estabilizar el flujo.
9. Añadir progreso y `AbortSignal` desde el inicio.

### Pruebas unitarias

- Snapshot no comparte referencias con `DocumentStore`.
- La huella cambia solo cuando cambia el contenido relevante.
- La transformación contenido→píxel es reversible dentro de tolerancia.
- Todo trazo aparece una vez en una región o fallback.
- SVG regional conserva cajas y estilo.
- Golden files de Markdown.
- Conflictos de nombres no sobrescriben archivos.

### Pruebas de integración

- Convertir mientras la misma pizarra está abierta en dos superficies.
- Continuar dibujando durante una conversión: el resultado usa el snapshot inicial y los trazos nuevos permanecen.
- Cancelar en cada etapa.
- Simular fallo de escritura entre recurso y nota.

### Criterio de aceptación

- Se genera una nota de prueba y recursos sin instalar ningún motor.
- El archivo `.blackboard` serializado antes y después es idéntico.
- Botón y comando terminan llamando al mismo caso de uso.
- El hilo de interfaz permanece utilizable.

## Fase 2 — Benchmark matemático

**Objetivo:** elegir un adaptador matemático con datos propios.

### Trabajo

- Crear servicio mínimo versionado para mathnote-ocr.
- Enviar trazos de una región, no la pizarra completa.
- Normalizar coordenadas y conservar el mapeo a IDs.
- Medir instalación CPU, arranque, latencia y RAM.
- Probar ink-on solo si la licencia de pesos se aclara; si ocurre, ejecutarlo en Worker y comparar.
- Validar LaTeX mediante parse/render, sin alterar silenciosamente el contenido.

### Casos difíciles

- ecuaciones multilínea;
- símbolos unidos entre regiones;
- matrices y sistemas;
- texto dentro de fórmula;
- tachaduras y correcciones;
- escritura fuera de orden temporal.

### Criterio de aceptación

- Licencias y hashes completos.
- Mejora medible frente a conservar toda fórmula como SVG.
- Umbral de confianza calibrado; por debajo se conserva SVG.
- Cancelación termina el trabajo sin dejar el servicio bloqueado.

## Fase 3 — Benchmark de texto español

**Objetivo:** seleccionar o rechazar motores de texto con evidencia.

### Trabajo

- Integrar PaddleOCR.js detrás de `TextRecognitionEngine`, con Worker y assets locales.
- Integrar TrOCR y/o PaddleOCR Python solo como baselines de servicio.
- Probar líneas segmentadas y regiones de varias líneas por separado.
- Medir tildes, `ñ`, puntuación y mezcla con símbolos matemáticos.
- Probar WASM y WebGPU donde estén disponibles, sin hacer WebGPU obligatorio.

### Criterio de aceptación

- CER/WER y errores por carácter publicados.
- Cero solicitudes de red durante inferencia offline.
- Sin congelamientos perceptibles del UI.
- Un motor solo se adopta si supera el umbral de calidad acordado; de lo contrario la fase concluye con “sin motor apto” y no se fuerza una selección.

## Fase 4 — Segmentación y documento mixto

**Objetivo:** convertir una pizarra completa preservando orden y regiones inciertas.

### Trabajo

- Mejorar agrupación de trazos en líneas y bloques.
- Clasificar texto, matemática, gráfico, mixto y desconocido.
- Comparar heurística propia con PP-StructureV3.
- Evaluar PaddleOCR-VL-1.6 como alternativa de página completa, manteniendo el contrato modular.
- Implementar nodos mixtos con runs de texto y LaTeX cuando la confianza lo permita.
- Añadir revisión de orden de lectura antes de guardar.

### Criterio de aceptación

- Ningún trazo queda sin representación en texto, LaTeX o recurso.
- El orden de lectura cumple el umbral acordado en el corpus.
- Las regiones de baja confianza se preservan automáticamente.
- Cambiar el motor de layout no cambia el ensamblador Markdown.

## Fase 5 — Experiencia de Obsidian

**Objetivo:** convertir el pipeline validado en una función utilizable.

### Trabajo

- Botón final en `GlobalToolbar` por ventana.
- Comando con atajo asignable desde Obsidian.
- Diálogo de destino, nombre, perfil y opciones.
- Progreso por etapa, cancelación, errores accionables y resumen de advertencias.
- Vista previa editable del documento intermedio o Markdown.
- Confirmación antes de sobrescribir o reemplazar resultados previos.
- Ajustes para carpetas de notas, recursos y modelos.

### Criterio de aceptación

- El usuario puede convertir desde vista, Markdown y Canvas.
- El destino se resuelve de forma correcta en ventanas desprendidas.
- No se sobrescribe ningún archivo sin confirmación.
- El resultado abre como nota válida con embeds relativos funcionales.

## Fase 6 — Empaquetado, móvil y mantenimiento

**Objetivo:** ofrecer una instalación sostenible sin degradar el plugin base.

### Trabajo

- Gestor explícito de modelos con tamaño, licencia, versión, hash y eliminación selectiva.
- Perfil “solo navegador” y perfil “servicio local”.
- Instalador reproducible del servicio para Linux; evaluar macOS/Windows por separado.
- Determinar capacidades reales de iOS/Android.
- Límites de memoria, mosaicos, caché y descarga reanudable.
- Telemetría desactivada; diagnóstico local exportable por el usuario.

### Criterio de aceptación

- Sin modelos, Blackboard conserva toda su funcionalidad actual.
- En plataformas no compatibles, la conversión se oculta o explica sin errores repetidos.
- Desinstalar modelos no toca notas, pizarras ni recursos del usuario.
- La guía offline se verifica desde una instalación limpia.

## Implementación mínima propuesta para la siguiente fase

La siguiente fase no debe integrar IA. Debe entregar solamente la columna vertebral:

1. `RecognitionSnapshot` inmutable creado desde la pizarra activa.
2. Render PNG de referencia con transformación de coordenadas.
3. Exportación SVG de una región por `strokeIds`.
4. Interfaces de motores y documento intermedio.
5. Un `MockRecognitionEngine` determinista.
6. Ensamblador Markdown mínimo.
7. Escritura a un destino de prueba sin sobrescritura.
8. Comando manual con cancelación; el botón puede añadirse en el mismo cambio si la integración queda pequeña.

Esto valida límites, flujo, UI y seguridad de datos antes de comprometer dependencias o pesos.

## Estructura propuesta, aún no creada

```text
src/
├── domain/recognition/
│   ├── snapshot.ts
│   ├── regions.ts
│   └── document.ts
├── application/recognition/
│   ├── ports.ts
│   ├── convert-blackboard.ts
│   ├── segment-document.ts
│   └── assemble-markdown.ts
├── infrastructure/recognition/
│   ├── snapshot-provider.ts
│   ├── reference-renderer.ts
│   ├── svg-region-exporter.ts
│   ├── mock-engine.ts
│   └── output-writer.ts
└── presentation/
    └── conversion-progress.ts
```

La ubicación final debe seguir los patrones del repositorio y puede simplificarse si aparecen módulos demasiado pequeños. No crear una jerarquía profunda antes de tener la primera prueba vertical.

## Matriz de aceptación final

| Requisito | Evidencia esperada |
| --- | --- |
| Trazos nunca eliminados | comparación byte/estructura y prueba E2E |
| Acción manual | prueba de comando y botón; ausencia de observador automático |
| Texto español | CER/WER sobre corpus separado por escritor |
| Matemáticas a LaTeX | exactitud normalizada y render equivalente |
| Gráficos preservados | cobertura de `strokeIds` y validación de embeds |
| Modularidad | contract tests con dos adaptadores falsos intercambiables |
| Offline | prueba con red bloqueada después de aprovisionar |
| Linux | instalación limpia reproducible y benchmark |
| Obsidian | nota válida, rutas relativas y ventanas desprendidas |
| Rendimiento | latencia p50/p95 y pico de RAM dentro del presupuesto |

## Bloqueos actuales

- No se ha medido ningún motor con manuscrito español de Caelestia-Ink.
- No hay licencia explícita verificada para los pesos derivados de CoMER usados por ink-on.
- Falta confirmar por escrito la cobertura de los pesos incluidos en mathnote-ocr.
- No existe presupuesto acordado de descarga, RAM, latencia ni plataformas objetivo para el servicio auxiliar.

Hasta resolverlos, la única implementación recomendada es el esqueleto sin motor real.
