---
title: Caelestia-Ink — Auditoría de Blackboard
status: en curso
date: 2026-11-16
cssclasses: [daily, oceano, medium-font]
---

# Auditoría de Blackboard

## Alcance

Auditoría estática del repositorio en el commit base `97bac45`. No se ejecutaron ni instalaron motores de reconocimiento. Las afirmaciones de funcionamiento existente se apoyan en el código y pruebas actuales; la conversión propuesta sigue sin implementar.

## 1. Funcionamiento interno

Blackboard separa responsabilidades de forma aprovechable:

| Capa | Componentes principales | Responsabilidad |
| --- | --- | --- |
| Dominio | `entities.ts`, `stroke-manager.ts`, `tool-manager.ts`, `geometry.ts` | datos, historial, herramientas y coordenadas |
| Aplicación | `document-store.ts`, `eraser-service.ts`, `export-service.ts`, casos de uso | sincronización, borrado y exportación |
| Infraestructura | `canvas-renderer.ts`, `obsidian-drawing-repository.ts` | render Canvas y acceso al vault |
| Presentación | `blackboard-view.ts`, `embed.ts`, `global-toolbar.ts`, `surface-manager.ts` | interacción y superficies de Obsidian |
| Plugin | `main.ts` | registro de vistas, comandos, extensiones y toolbars |

Flujo de edición:

1. `BlackboardView` o un embed monta un `DrawingEngine`.
2. Los eventos de puntero se convierten de pantalla a coordenadas de contenido.
3. `DrawingEngine` acumula puntos y crea un `Stroke` al terminar el gesto.
4. `StrokeManager` actualiza trazos e historial.
5. La superficie solicita persistencia.
6. `DocumentStore` reemplaza el documento canónico, guarda con debounce y notifica otras superficies del mismo archivo.
7. `ObsidianDrawingRepository` serializa el archivo `.blackboard` en el vault.

La vista usa dos canvases: uno estático para trazos terminados y otro para el trazo activo. Esto reduce repintados, pero ambos son representación visual; la fuente de verdad continúa siendo `Stroke[]`.

## 2. Persistencia de trazos

El archivo `.blackboard` es JSON legible. `src/application/file-format.ts` usa `JSON.stringify` y `JSON.parse`; la versión actual creada por defecto es 3.

```ts
interface BlackboardFile {
  version: number;
  width: number;
  height: number;
  strokes: Stroke[];
  background: { color: string };
  contentBounds?: { x: number; y: number; width: number; height: number };
}
```

`DocumentStore` mantiene un documento compartido por ruta. `SharedDocumentHandle.getStrokes()` devuelve los trazos canónicos y `commit(file)` persiste y sincroniza las demás superficies. Para reconocimiento debe copiarse el contenido antes de iniciar trabajo asíncrono.

## 3. Coordenadas y propiedades

```ts
type Point = [number, number, number];

interface Stroke {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  points: Point[];
  hasPressure: boolean;
  timestamp: number;
}
```

Interpretación de `Point`:

- índice 0: coordenada X de contenido;
- índice 1: coordenada Y de contenido;
- índice 2: presión normalizada usada por el render; 0.5 es el valor neutral sin presión diferenciada.

Las coordenadas pertenecen al espacio de la pizarra, no a píxeles físicos ni al viewport actual. El render aplica `ViewTransform`; el reconocimiento debe operar antes de esa transformación o conservar su inversa.

Propiedades relevantes:

- `id` preserva identidad durante historial y segmentación.
- `timestamp` indica cuándo terminó el trazo, pero no define de forma fiable el orden de lectura.
- `tool`, color y opacidad permiten excluir o tratar por separado resaltadores.
- `size` debe incluirse al calcular cajas para no recortar bordes.
- `contentBounds` es caché recomputable, no dato autoritativo.

Limitación de validación: `validateFileData` comprueba solo parte de la forma de cada trazo. Una fase futura debería validar y normalizar números finitos en el snapshot sin cambiar el archivo original.

## 4. Dibujo, historial y borrado

### Dibujo

`DrawingEngine.beginStroke()` abre un gesto, `addPoint()` evita duplicados consecutivos y `endStroke()` crea el objeto final con UUID, estilo, puntos, presión y timestamp.

`perfect-freehand` convierte los puntos en el contorno visual usado por Canvas y SVG. Esta dependencia puede conservarse para renderizar imágenes y recursos con la misma apariencia.

### Herramientas

`ToolManager` conserva una herramienta global compartida entre superficies:

- pluma;
- resaltador;
- borrador.

El borrador no es un `Stroke`; actúa sobre los trazos existentes.

### Borrado

Existen dos operaciones:

- `eraseAtPoint()` detecta intersecciones y elimina trazos completos.
- `eraseStrokesAlongSegment()` elimina el fragmento tocado, divide el resto en recorridos y genera IDs derivados como `original~0`.

El historial de `StrokeManager` soporta agregar, eliminar, mover, reemplazar, limpiar, deshacer y rehacer. El reconocimiento no debe entrar en ese historial porque no modifica la pizarra.

## 5. Botón en la interfaz

El punto de integración es `src/presentation/global-toolbar.ts`:

- `GlobalToolbar.build()` crea botones con `iconButton()`.
- Los controles llaman a la superficie activa y después sincronizan su estado.
- `main.ts:ensureToolbar()` construye una toolbar por ventana e inyecta callbacks de nivel aplicación.

Propuesta mínima:

1. Inyectar un callback `onConvert` en `GlobalToolbar`.
2. Añadir un botón con icono, `aria-label`, `title` y `data-action` consistentes.
3. Deshabilitarlo si no existe una pizarra activa o ya hay una conversión para esa superficie.
4. Invocar el caso de uso; la toolbar no debe segmentar, reconocer ni escribir archivos.

Debe probarse en ventana principal y ventanas desprendidas, porque cada una tiene su propia toolbar y documento DOM.

## 6. Comando y atajo configurable

`src/main.ts` ya registra comandos con `this.addCommand(...)`. La conversión debe añadir un comando con:

- ID estable, por ejemplo `convert-active-blackboard-to-markdown`;
- nombre visible;
- `checkCallback` para comprobar que hay destino activo y habilitar/deshabilitar el comando;
- llamada al mismo caso de uso que el botón.

No se debe imponer un atajo predeterminado. Obsidian expone todos los comandos registrados en **Atajos de teclado**, donde el usuario puede asignarlo y evitar colisiones.

## 7. Exportación completa de trazos

No hace falta inferir trazos desde el canvas. Están disponibles directamente en:

- el `DrawingEngine` de una superficie montada;
- `DocumentStore`, fuente canónica mientras el archivo está compartido;
- `IDrawingRepository.load(path)`, para un archivo no montado.

La exportación para reconocimiento debe ser un snapshot profundo que preserve:

- orden actual del arreglo;
- IDs;
- puntos y presión;
- propiedades de estilo;
- timestamp;
- dimensiones y límites;
- ruta y versión del archivo.

Blackboard no almacena agrupaciones semánticas de palabra, línea, fórmula o diagrama. Las únicas agrupaciones nativas son trazos individuales; cualquier región es un producto derivado y debe guardar la lista de `strokeIds` que la originó.

## 8. Imagen de referencia sin alterar Blackboard

Opciones existentes:

- `DrawingEngine.exportThumbnail()` renderiza todos los trazos en un canvas separado, pero limita el resultado a 256 px; es insuficiente para OCR.
- `exportSvg()` genera una representación vectorial transparente a partir de `Stroke[]`.

Recomendación:

1. Crear un renderizador independiente que reciba el snapshot.
2. Renderizar en canvas fuera del DOM a una resolución definida por el pipeline.
3. Usar límites de contenido y padding reproducibles.
4. Devolver la transformación contenido→píxel.
5. Dividir en mosaicos cuando una sola imagen sea demasiado grande.

No debe cambiar el zoom, el viewport, los canvases visibles, `StrokeManager` ni `DocumentStore`.

## 9. Dependencias conservables

| Dependencia o herramienta | Decisión | Motivo |
| --- | --- | --- |
| `perfect-freehand` | Conservar | render uniforme de trazos y exportación SVG |
| `@jaames/iro` | Conservar sin cambios | selector de color; no interviene en reconocimiento |
| Obsidian API | Conservar | comandos, vault, vistas, notices y escritura de notas |
| esbuild | Conservar | build actual; evaluar assets WASM/Worker antes de integrar motores web |
| Vitest | Conservar | pruebas unitarias y contract tests |
| WebdriverIO | Conservar | pruebas E2E en Obsidian escritorio y móvil |
| TypeScript | Conservar | contratos neutrales entre módulos |

No hay razón para reemplazar `DrawingEngine`, `DocumentStore`, `StrokeManager`, la toolbar o el repositorio.

## 10. Componentes adicionales

Se requieren, como módulos nuevos:

1. resolución del destino activo;
2. captura y validación de snapshot;
3. rasterización de referencia;
4. segmentación de regiones;
5. clasificación texto/matemática/gráfico/mixto;
6. puertos de motores y adaptadores;
7. documento intermedio estructurado;
8. preservador SVG/PNG;
9. ensamblador Markdown;
10. escritor atómico de nota y recursos;
11. progreso, cancelación y revisión;
12. gestor de modelos, licencias, hashes y disponibilidad offline;
13. opcionalmente, cliente y servicio auxiliar local.

## 11. Ejecución directa frente a servicio auxiliar

| Motor | Dentro del plugin | Servicio auxiliar | Estado |
| --- | --- | --- | --- |
| PaddleOCR.js | Sí, navegador/Worker | No requerido | Viable técnicamente para OCR de imagen; precisión manuscrita pendiente |
| ink-on | Sí, ONNX Runtime Web/Worker | No requerido | Bloqueado por licencia no aclarada de pesos |
| mathnote-ocr | No de forma natural | Sí, Python/PyTorch | Candidato matemático para experimento |
| PaddleOCR Python / PP-Structure | No recomendable | Sí, Python/PaddlePaddle | Candidato de layout/OCR pesado |
| PaddleOCR-VL | No | Sí | Candidato experimental de página completa; pesado |
| TrOCR | No recomendable | Sí, Python/PyTorch | Solo experimento de líneas de texto |
| TeXForm | No incorporar | Su diseño usa FastAPI | Referencia arquitectónica, licencia ausente |

## 12. Riesgos

### Compatibilidad

- **Móvil:** no puede asumirse Python, procesos hijos ni loopback estable. Mantener dibujo intacto y degradar la conversión explícitamente.
- **Worker/WASM:** esbuild debe copiar y resolver workers y WASM; no depender de CDN en modo offline.
- **WebGPU:** disponibilidad variable entre Electron, Linux y móvil. WASM debe ser fallback.
- **COOP/COEP:** el runtime web puede limitar hilos si Obsidian no ofrece cabeceras aisladas.
- **Ventanas desprendidas:** el contexto activo y los assets DOM pertenecen a ventanas diferentes.
- **Formato:** añadir resultados de reconocimiento al `.blackboard` rompería responsabilidades y podría afectar compatibilidad; deben vivir fuera.

### Rendimiento

- Dos canvases por embed ya consumen memoria; cargar modelos por superficie multiplicaría el costo. Debe existir un gestor compartido por plugin.
- Una imagen de página completa puede superar límites de textura o memoria; usar límites de píxeles y mosaicos.
- TrOCR y PaddleOCR-VL son demasiado grandes para cargarse en el hilo UI.
- PyTorch/PaddlePaddle aumentan mucho instalación y arranque; deben estar aislados del plugin.
- Reconocer toda la pizarra en cada cambio sería costoso; la ejecución será manual y la caché se basará en huellas.

### Calidad

- No existe un motor ya validado para español manuscrito libre mezclado con matemáticas.
- TrOCR base está ajustado a IAM en inglés y a imágenes de una línea.
- Los modelos OCR generales pueden reconocer texto impreso mejor que manuscrito de stylus.
- El orden temporal de trazos no equivale al orden de lectura.
- Resaltadores, tachaduras, flechas, matrices y fórmulas multilínea confunden segmentación.
- La confianza de distintos motores no es directamente comparable; necesita calibración.

### Legal y distribución

- Licencia del código y licencia/procedencia de pesos deben registrarse por separado.
- No distribuir pesos cuya autorización no sea explícita.
- Los modelos descargados deben fijarse por versión y hash; “latest” no es reproducible.

## Conclusión de auditoría

La base ya ofrece los datos vectoriales, sincronización, render, SVG, toolbar y comandos necesarios. La conversión puede añadirse como un pipeline lateral sin reescribir Blackboard. La brecha principal no está en capturar los trazos, sino en segmentar una página libre y validar un motor de texto español mezclado con matemáticas.
