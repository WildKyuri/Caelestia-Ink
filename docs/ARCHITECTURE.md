---
title: Caelestia-Ink — Arquitectura de reconocimiento
status: en curso
date: 2026-11-17
cssclasses: [daily, oceano, medium-font]
---

# Arquitectura de reconocimiento

## Estado de la decisión

La columna vertebral de conversión ya está implementada y MathNote OCR 0.2.1 cuenta con un
proveedor experimental de escritorio. No es todavía el motor matemático definitivo: la
evaluación real muestra errores suficientes para exigir vista previa y fallback SVG.

La implementación conserva la arquitectura lateral: snapshot inmutable, regiones,
`RecognitionEngine`, documento intermedio, ensamblador Markdown, recursos y escritor. No se
modificaron `DrawingEngine`, `DocumentStore` ni el formato `.blackboard`.

Decisiones firmes:

1. Blackboard permanece como interfaz de escritura y fuente canónica de trazos.
2. La conversión es manual: botón o comando de Obsidian con atajo configurable.
3. Una conversión trabaja sobre una copia inmutable y nunca edita ni elimina trazos.
4. Reconocimiento, estructura documental y generación Markdown son módulos separados.
5. Todo motor debe funcionar localmente y sin conexión después de descargar sus artefactos.
6. Una región incierta se conserva como SVG o PNG en vez de inventar contenido.
7. La conversión no puede bloquear el hilo de interfaz durante inferencias largas.
8. MyScript iink, MathPix y cualquier API comercial, cuota o suscripción quedan fuera de la arquitectura.

Decisiones pendientes de experimentación:

- Motor de texto para manuscrito español.
- Clasificación de regiones mixtas de texto y matemáticas.
- Segmentación y orden de lectura de una pizarra libre.
- Umbrales de confianza y política de conservación gráfica.
- Motor matemático definitivo y viabilidad de su licencia de pesos.
- Perfil móvil: inferencia en navegador, conversión limitada o función deshabilitada con explicación.

## Restricciones del sistema actual

- El archivo `.blackboard` contiene datos vectoriales y debe seguir siendo compatible.
- Una pizarra puede estar abierta simultáneamente como vista, embed Markdown y nodo Canvas. `DocumentStore` conserva una única versión canónica.
- La toolbar existe una vez por ventana y se dirige a la superficie activa mediante `SurfaceManager`.
- El plugin no es solo de escritorio (`manifest.json` declara `isDesktopOnly: false`). Un servicio Python local no estará disponible de forma uniforme en móvil.
- El bundle actual usa esbuild y solo tiene dos dependencias de ejecución: `perfect-freehand` e `@jaames/iro`.

## Flujo propuesto

```text
botón / comando
    │
    ▼
resolver pizarra activa
    │
    ▼
snapshot inmutable + huella
    ├── trazos originales normalizados
    ├── límites y dimensiones
    └── imagen de referencia de alta resolución
    │
    ▼
segmentación y orden de lectura
    │
    ├── región de texto ─────► TextRecognitionEngine
    ├── región matemática ──► MathRecognitionEngine
    ├── región gráfica ─────► GraphicPreserver
    └── región incierta ────► GraphicPreserver
    │
    ▼
documento intermedio estructurado
    │
    ▼
ensamblador Markdown
    │
    ├── nota .md
    └── recursos .svg / .png
```

El pipeline consume un snapshot cerrado. Si el usuario sigue dibujando, esos cambios pertenecen a una conversión posterior. Así se evita mezclar revisiones y no es necesario bloquear Blackboard.

## Modelo de entrada inmutable

El snapshot debe conservar coordenadas de dibujo; no debe depender del zoom, desplazamiento, DPR ni tamaño actual del panel.

```ts
type Point3 = readonly [x: number, y: number, pressure: number];

interface StrokeSnapshot {
  readonly id: string;
  readonly tool: 'pen' | 'highlighter';
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  readonly points: readonly Point3[];
  readonly hasPressure: boolean;
  readonly timestamp: number;
}

interface RecognitionSnapshot {
  readonly sourcePath: string;
  readonly sourceVersion: number;
  readonly fingerprint: string;
  readonly capturedAt: number;
  readonly width: number;
  readonly height: number;
  readonly contentBounds: Rect;
  readonly strokes: readonly StrokeSnapshot[];
}
```

La huella debe calcularse sobre una serialización estable del contenido relevante. Sirve para trazabilidad, caché y para demostrar que el resultado corresponde a una revisión concreta; no reemplaza el contenido `.blackboard`.

La primera implementación debe hacer una copia profunda. `SharedDocumentHandle.getStrokes()` devuelve la colección canónica viva y no debe entregarse directamente a trabajos asíncronos.

## Imagen de referencia

Se requiere un rasterizador puro que reciba el snapshot, no el canvas visible:

```ts
interface ReferenceRenderer {
  render(snapshot: RecognitionSnapshot, options: RenderOptions): Promise<RenderedPage>;
}

interface RenderedPage {
  blob: Blob;
  mimeType: 'image/png';
  pixelWidth: number;
  pixelHeight: number;
  contentToPixel: AffineTransform;
}
```

Reglas:

- Renderizar en un `OffscreenCanvas` cuando esté disponible o en un canvas DOM no montado.
- Usar fondo explícito de alto contraste para OCR; el color visual de Blackboard no debe alterar los datos.
- Conservar una transformación reversible entre coordenadas de trazos y píxeles.
- Permitir mosaicos si la pizarra supera el límite de textura o memoria.
- No usar `exportThumbnail()` para OCR: está limitado a 256 px y está pensado como miniatura.
- Reutilizar las opciones de `perfect-freehand` y la lógica SVG existentes para mantener la geometría visual.

## Segmentación y clasificación

La segmentación es independiente de los motores. Debe producir regiones aun cuando no haya un clasificador aprendido.

```ts
type RegionKind = 'text' | 'math' | 'graphic' | 'mixed' | 'unknown';

interface DocumentRegion {
  id: string;
  bounds: Rect;
  strokeIds: string[];
  kind: RegionKind;
  confidence: number;
  readingOrder?: number;
  image?: ImageCrop;
}

interface RegionSegmenter {
  segment(input: SegmentationInput, signal: AbortSignal): Promise<DocumentRegion[]>;
}
```

Estrategia incremental:

1. Agrupar trazos por proximidad espacial, solapamiento vertical y distancia temporal; no asumir que tiempo equivale a orden de lectura.
2. Crear líneas y bloques candidatos mediante cajas de trazos.
3. Marcar como `mixed` o `unknown` cuando texto y símbolos no puedan separarse con confianza.
4. Permitir que un motor de layout reemplace el segmentador heurístico sin cambiar los reconocedores.
5. Conservar los `strokeIds` de cada región para generar un SVG exacto como fallback.

## Contratos de motores

Los adaptadores ocultan si la inferencia ocurre en un Worker JavaScript o en un proceso auxiliar local.

```ts
interface EngineDescriptor {
  id: string;
  version: string;
  execution: 'browser-worker' | 'local-service';
  capabilities: readonly ('text' | 'math' | 'layout')[];
  languages?: readonly string[];
  offlineReady: boolean;
}

interface RecognitionContext {
  snapshot: RecognitionSnapshot;
  region: DocumentRegion;
  image: ImageCrop;
}

interface TextRecognitionEngine {
  descriptor(): EngineDescriptor;
  recognizeText(input: RecognitionContext, signal: AbortSignal): Promise<TextCandidate[]>;
}

interface MathRecognitionEngine {
  descriptor(): EngineDescriptor;
  recognizeMath(input: RecognitionContext, signal: AbortSignal): Promise<MathCandidate[]>;
}

interface LayoutEngine {
  descriptor(): EngineDescriptor;
  analyze(page: RenderedPage, signal: AbortSignal): Promise<LayoutCandidate>;
}
```

Los resultados deben incluir confianza, geometría, versión del motor y advertencias. Un adaptador no puede escribir Markdown ni guardar archivos.

### Adaptadores de ejecución

**Worker del plugin**

- Adecuado para ONNX Runtime Web, como PaddleOCR.js.
- Sin proceso externo y potencialmente compatible con móvil.
- Debe alojar localmente WASM y modelos para garantizar modo offline.
- Debe controlar memoria, cancelación y disponibilidad de WebGPU/WASM.

**Servicio auxiliar local**

- Proceso Python separado para PyTorch/PaddlePaddle.
- Comunicación por protocolo JSON versionado. La implementación MathNote usa stdin/stdout,
  no abre puertos y no escucha ni siquiera en loopback.
- Inicio explícito o gestionado, health check, timeout, cancelación y cierre limpio.
- Los archivos no salen del equipo.
- Solo viable en escritorio salvo que exista un runtime equivalente en móvil.

El protocolo debe intercambiar tipos neutrales, no clases específicas de un framework:

```ts
interface RecognitionRequest {
  protocolVersion: 1;
  jobId: string;
  task: 'text' | 'math' | 'layout';
  region: DocumentRegion;
  strokes?: StrokeSnapshot[];
  imagePngBase64?: string;
}
```

## Documento intermedio

La salida común evita que Markdown dependa del motor:

```ts
type DocumentNode =
  | { type: 'heading'; level: number; text: string; source: SourceRef }
  | { type: 'paragraph'; text: string; source: SourceRef }
  | { type: 'display-math'; latex: string; source: SourceRef }
  | { type: 'inline-mixed'; runs: InlineRun[]; source: SourceRef }
  | { type: 'list'; ordered: boolean; items: DocumentNode[][]; source: SourceRef }
  | { type: 'graphic'; asset: PendingAsset; alt: string; source: SourceRef }
  | { type: 'unknown'; asset: PendingAsset; warning: string; source: SourceRef };

interface RecognizedDocument {
  sourcePath: string;
  sourceFingerprint: string;
  engineRuns: EngineRun[];
  nodes: DocumentNode[];
  warnings: RecognitionWarning[];
}
```

`SourceRef` debe contener región, caja y `strokeIds`. Esto permite revisar el resultado, regenerar un recurso y explicar de dónde salió cada fragmento.

## Generación Markdown y recursos

```ts
interface MarkdownAssembler {
  assemble(document: RecognizedDocument, options: MarkdownOptions): MarkdownDraft;
}

interface ConversionOutputWriter {
  writeAtomically(draft: MarkdownDraft, destination: Destination): Promise<WrittenOutput>;
}
```

Reglas del ensamblador:

- Texto en Markdown normal.
- Matemática inline con `$...$` y de bloque con `$$...$$`.
- Escapar delimitadores y validar balance básico, sin “corregir” semántica desconocida.
- Diagramas e incertidumbres como embeds de Obsidian con rutas relativas.
- Preferir SVG generado desde los trazos asociados. Usar PNG si un SVG fiel no es posible o si el motor solo entrega una región rasterizada.
- Añadir advertencias fuera del cuerpo reconocido o en metadatos configurables; no ocultar fallos.
- Escribir primero en temporales y publicar nota y recursos como una unidad lógica. Ante error, no dejar una nota que apunte a recursos inexistentes.

La política para un destino ya existente debe pedir confirmación o generar un nombre nuevo. Nunca sobrescribir silenciosamente.

## Integración mínima con Blackboard

No se necesita refactorizar el motor de dibujo.

1. Añadir un caso de uso `ConvertBlackboardUseCase` en `src/application/`.
2. Añadir un resolver de contexto activo que obtenga ruta y snapshot sin ampliar las responsabilidades de renderizado.
3. Inyectar un callback de conversión en `GlobalToolbar`, igual que los callbacks existentes para crear o insertar dibujos.
4. Registrar un comando con `Plugin.addCommand`; al no fijar `hotkeys`, Obsidian permite que el usuario asigne el atajo.
5. Compartir el mismo caso de uso entre botón y comando.
6. Mostrar progreso, permitir cancelar y presentar un borrador antes de guardar.

`DrawingSurface` hoy expone controles de herramienta, no identidad documental. No conviene añadir reconocimiento a esa interfaz. Se propone un contrato lateral:

```ts
interface ConversionTarget {
  sourcePath: string;
  createSnapshot(): RecognitionSnapshot;
}

interface ConversionTargetResolver {
  getActive(): ConversionTarget | null;
}
```

## Caché y repetición

- Clave primaria: huella de snapshot + versión de segmentador + versiones de motores + opciones.
- Guardar resultados intermedios solo si el usuario lo habilita.
- No almacenar imágenes fuera del vault o directorio de datos del plugin sin informar.
- Una conversión repetida con entradas y versiones idénticas debe producir el mismo documento intermedio, salvo que el motor declare no determinismo.

## Seguridad y privacidad

- Inferencia local por defecto y sin solicitudes externas durante una conversión.
- Descargas de modelos separadas de la inferencia, explícitas y verificadas mediante hash.
- Lista de artefactos con origen, versión y licencia.
- Servicio auxiliar sin red cuando sea posible; si otro motor necesita HTTP, debe limitarse
  a loopback y token efímero. MathNote usa pipes y límites de 4.000 trazos/60.000 puntos.
- No ejecutar LaTeX ni contenido reconocido como comandos.
- Sanitizar nombres de recursos y rutas de destino.

## Pruebas arquitectónicas

| Capa | Prueba mínima |
| --- | --- |
| Snapshot | copia profunda, huella estable y coordenadas intactas |
| Raster | dimensiones, transformación y render sin tocar el canvas visible |
| Segmentación | regiones cubren los trazos sin perder ni duplicar IDs |
| Adaptadores | contract tests con fixtures y cancelación |
| Documento intermedio | validación de esquema y trazabilidad por nodo |
| Markdown | golden files para texto, LaTeX, listas y gráficos |
| Escritura | comportamiento atómico y conflictos de nombre |
| Integración | botón y comando invocan el mismo caso de uso |
| No regresión | el `.blackboard` es idéntico antes y después de convertir |

## Referencias internas

- Auditoría actual: [BLACKBOARD-AUDIT.md](BLACKBOARD-AUDIT.md)
- Evaluación de motores: [RECOGNITION-ENGINES.md](RECOGNITION-ENGINES.md)
- Plan incremental: [IMPLEMENTATION-ROADMAP.md](IMPLEMENTATION-ROADMAP.md)
