import type { BlackboardFile } from './entities';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SnapshotPoint = readonly [number, number, number];

export interface SnapshotStroke {
  readonly id: string;
  readonly tool: 'pen' | 'highlighter';
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  readonly points: readonly SnapshotPoint[];
  readonly hasPressure: boolean;
  readonly timestamp: number;
}

export interface RecognitionSnapshot {
  readonly sourcePath: string;
  readonly sourceVersion: number;
  readonly fingerprint: string;
  readonly width: number;
  readonly height: number;
  readonly contentBounds: Readonly<Rect>;
  readonly strokes: readonly SnapshotStroke[];
}

/** Live surface adapter. Both getters are read on demand: a view's file is assigned after
 * onOpen, so a value captured at registration time would stay empty. getFile must return a
 * detached value; snapshot creation copies again. */
export interface ConversionTarget {
  getSourcePath(): string;
  getFile(): BlackboardFile;
  /** Markdown note that owns an embedded surface. Undefined/null means the caller must ask. */
  getDestinationNotePath?(): string | null;
}

export type RegionKind = 'text' | 'math' | 'table' | 'graphic' | 'unknown';

export interface RecognitionRegion {
  readonly id: string;
  readonly bounds: Readonly<Rect>;
  readonly strokeIds: readonly string[];
  readonly kind: RegionKind;
  readonly readingOrder: number;
}

/**
 * What a recognition engine believes a region contains. `kind` decides how the assembler
 * exports it; the payload fields are optional because an engine may only classify a region
 * without transcribing it. Missing payload for a known kind is treated as pending, never
 * invented by the assembler.
 */
export interface RegionContent {
  readonly kind: RegionKind;
  readonly text?: string;
  readonly latex?: string;
  readonly headers?: readonly string[];
  readonly rows?: readonly (readonly string[])[];
  readonly caption?: string;
  readonly confidence?: number;
}

export interface RegionRecognition {
  readonly regionId: string;
  readonly content: RegionContent;
}

export interface IntermediateDocument {
  readonly sourcePath: string;
  readonly sourceFingerprint: string;
  readonly engineId: string;
  readonly simulated: boolean;
  readonly regions: readonly RegionRecognition[];
  readonly warnings: readonly string[];
}

export interface RecognitionEngine {
  readonly id: string;
  /** Page engines receive one region containing every stroke; region engines keep segmentation. */
  readonly inputMode?: 'page' | 'regions';
  recognize(
    snapshot: RecognitionSnapshot,
    regions: readonly RecognitionRegion[],
    signal: AbortSignal,
  ): Promise<IntermediateDocument>;
}

export interface ReferenceImage {
  readonly data: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly contentBounds: Readonly<Rect>;
}

/** Kept for the diagnostics/preview path even though the note no longer embeds a full PNG. */
export interface ReferenceRenderer {
  render(snapshot: RecognitionSnapshot, signal: AbortSignal): Promise<ReferenceImage>;
}

export interface RegionAssetExporter {
  export(snapshot: RecognitionSnapshot, region: RecognitionRegion): string;
}

export interface OutputAsset {
  readonly key: string;
  readonly fileName: string;
  readonly mimeType: 'image/png' | 'image/svg+xml';
  readonly data: string | ArrayBuffer;
}

export interface ConversionDestination {
  readonly notePath: string;
  readonly assetFolder: string;
  /** Omitted for the legacy create-note flow. OCR integration inserts into an existing note. */
  readonly mode?: 'create' | 'append';
  /** Snapshot fingerprint used to reject an accidental duplicate insertion. */
  readonly idempotencyKey?: string;
}

/** Region id → the export kind chosen by the engine or corrected by the user. */
export type ConversionClassification = ReadonlyMap<string, RegionKind>;

export interface RenderedConversion {
  readonly markdown: string;
  readonly assets: readonly OutputAsset[];
}

export interface RegionDiagnostic {
  readonly regionId: string;
  readonly readingOrder: number;
  readonly strokeCount: number;
  readonly bounds: Readonly<Rect>;
  readonly kind: RegionKind;
  readonly engineKind: RegionKind;
  readonly engineId: string;
  readonly simulated: boolean;
  readonly confidence?: number;
  readonly note?: string;
}

/** Internal record only. It is never written into the generated note. */
export interface ConversionDiagnostics {
  readonly engineId: string;
  readonly simulated: boolean;
  readonly fingerprint: string;
  readonly durationMs: number;
  readonly strokeCount: number;
  readonly regionCount: number;
  readonly regions: readonly RegionDiagnostic[];
  readonly warnings: readonly string[];
}

export interface ConversionDraft {
  readonly destination: ConversionDestination;
  readonly snapshot: RecognitionSnapshot;
  readonly document: IntermediateDocument;
  readonly regions: readonly RecognitionRegion[];
  readonly markdown: string;
  readonly assets: readonly OutputAsset[];
  readonly diagnostics: ConversionDiagnostics;
}

export type ConversionStage = 'snapshot' | 'segment' | 'recognize' | 'assemble';

export interface ConversionProgress {
  readonly stage: ConversionStage;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

export type ProgressReporter = (progress: ConversionProgress) => void;
