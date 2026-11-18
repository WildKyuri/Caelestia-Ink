export const FILE_EXTENSION = 'blackboard';

export type Point = [number, number, number];

export interface Background {
  type: 'blank' | 'dot-grid' | 'line-grid' | 'square-grid';
  color: string;
  grid: boolean;
  gridSize: number;
}

export interface Stroke {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  points: Point[];
  hasPressure: boolean;
  timestamp: number;
}

export interface ToolState {
  activeTool: 'pen' | 'highlighter' | 'eraser';
  penColor: string;
  penSize: number;
  highlighterColor: string;
  highlighterSize: number;
  eraserSize: number;
}

/**
 * Normalized top-left of the floating toolbar inside the active view: 0,0 is the top-left
 * corner of the usable area and 1,1 the bottom-right. Stored instead of pixels so the
 * toolbar keeps its relative place when the window moves, resizes or changes monitor.
 */
export interface ToolbarPosition {
  x: number;
  y: number;
}

/**
 * Starting color and size for each tool, given once to the plugin's single shared
 * `ToolManager` when the plugin loads.
 */
export const DEFAULT_TOOL_STATE: ToolState = {
  activeTool: 'pen',
  penColor: '#ffffff',
  penSize: 2,
  highlighterColor: '#ffff00',
  // The highlighter has its own wider size scale (HIGHLIGHTER_SIZES), and 22 is its middle
  // preset so it looks like a marker. The eraser default (8) is one of the PEN_SIZES presets
  // so the size popover can mark its dot as selected.
  highlighterSize: 22,
  eraserSize: 8,
};

export type StrokeAction =
  | { type: 'add'; stroke: Stroke }
  | { type: 'delete'; strokeId: string; stroke: Stroke }
  | { type: 'move'; strokeIds: string[]; dx: number; dy: number }
  | { type: 'clear'; strokes: Stroke[] };

export interface PluginSettings {
  drawingFolder: string;
  newFileLocation: 'fixed' | 'current';
  autoExportSvg: boolean;
  svgExportPath: string;
  /** Exactly eight color shortcuts (6-digit hex) in toolbar display order. */
  paletteColors: string[];
  /**
   * Shows the collapsed toolbar pill (the round button that opens the toolbar) on Markdown
   * and Canvas views with no active drawing. False hides only that pill; a pill the user
   * collapses on an active drawing still shows.
   */
  showToolbarPill: boolean;
  /**
   * Where the full floating toolbar sits inside the active view, normalized to 0..1.
   * Null keeps the default (bottom centre). Set by dragging the toolbar grip.
   */
  toolbarPosition: ToolbarPosition | null;
  /**
   * CSS color painted behind every drawing surface (full-page view, Markdown embed and
   * Canvas node). The default '#000000' is a blackboard; '#ffffff' gives a whiteboard, and
   * any CSS color works. It only applies on screen (SVG export stays transparent).
   */
  boardBackground: string;
  /**
   * Absolute path of a Python interpreter that has `mathnote-ocr` installed. Empty disables
   * recognition (the conversion command then says so instead of guessing). Only used on
   * desktop; the plugin never runs board content as code and never sends paths to Python.
   */
  mathNotePythonPath: string;
  /** Recognition backend selected for explicit, on-demand conversion. */
  recognitionEngine: 'ollama' | 'mathnote' | 'disabled';
  /** Strictly local Ollama API origin; validation rejects non-local hosts. */
  ollamaBaseUrl: string;
  /** Fixed tested model for this integration. */
  ollamaModel: string;
  ollamaTimeoutSeconds: number;
  ollamaMaxRetries: number;
}

/** The eight color-popover shortcuts seeded by default, in display order. */
export const DEFAULT_PALETTE_COLORS = [
  '#000000', '#ffffff', '#ff0000', '#0000ff', '#00ff00', '#ffff00', '#ffa500', '#800080',
];

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  drawingFolder: 'Blackboard',
  newFileLocation: 'fixed',
  autoExportSvg: false,
  svgExportPath: '',
  paletteColors: [...DEFAULT_PALETTE_COLORS],
  showToolbarPill: true,
  toolbarPosition: null,
  boardBackground: '#000000',
  mathNotePythonPath: '',
  recognitionEngine: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'glm-ocr:q8_0',
  ollamaTimeoutSeconds: 180,
  ollamaMaxRetries: 3,
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** True when the string holds a C0 control character, which must never reach a spawn arg. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) < 0x20) return true;
  }
  return false;
}

export interface BlackboardFile {
  version: number;
  /** Content bounding-box width, cached on save (recomputable from strokes). */
  width: number;
  /** Content bounding-box height, cached on save (recomputable from strokes). */
  height: number;
  strokes: Stroke[];
  background: { color: string };
  /** Cached drawing-space content bounding box (recomputable from strokes). */
  contentBounds?: { x: number; y: number; width: number; height: number };
}

export function createDefaultFile(_settings: PluginSettings): BlackboardFile {
  return {
    version: 3,
    width: 800,
    height: 600,
    strokes: [],
    background: { color: 'transparent' },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

export function validateFileData(raw: unknown): BlackboardFile | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.version !== 'number') return null;
  if (!Array.isArray(raw.strokes)) return null;

  const strokes = raw.strokes.filter((s: unknown): s is Stroke =>
    isRecord(s) && typeof s.id === 'string' &&
    Array.isArray(s.points) &&
    typeof s.color === 'string' &&
    typeof s.tool === 'string'
  );

  const result: BlackboardFile = {
    version: raw.version,
    width: (typeof raw.width === 'number' && raw.width > 0) ? raw.width : 800,
    height: (typeof raw.height === 'number' && raw.height > 0) ? raw.height : 600,
    strokes,
    background: isRecord(raw.background) && typeof raw.background.color === 'string'
      ? { color: raw.background.color }
      : { color: 'transparent' },
  };
  if (isRecord(raw.contentBounds)) {
    const cb = raw.contentBounds;
    if (typeof cb.x === 'number' && typeof cb.y === 'number' &&
        typeof cb.width === 'number' && cb.width >= 0 &&
        typeof cb.height === 'number' && cb.height >= 0) {
      result.contentBounds = { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
    }
  }
  return result;
}

export function validateSettings(settings: PluginSettings): PluginSettings {
  const result = { ...settings };
  if (typeof result.drawingFolder !== 'string') {
    result.drawingFolder = 'Blackboard';
  }
  if (result.newFileLocation !== 'fixed' && result.newFileLocation !== 'current') {
    result.newFileLocation = 'fixed';
  }
  if (typeof result.autoExportSvg !== 'boolean') {
    result.autoExportSvg = false;
  }
  if (typeof result.svgExportPath !== 'string') {
    result.svgExportPath = '';
  }
  if (typeof result.showToolbarPill !== 'boolean') {
    result.showToolbarPill = true;
  }
  // Toolbar position: null or a pair of finite 0..1 coordinates. Anything else falls back to
  // the default bottom-centre placement instead of leaving the toolbar off-screen.
  {
    const raw = result.toolbarPosition as unknown;
    if (raw == null) {
      result.toolbarPosition = null;
    } else if (
      !isRecord(raw) ||
      typeof raw.x !== 'number' || !Number.isFinite(raw.x) ||
      typeof raw.y !== 'number' || !Number.isFinite(raw.y)
    ) {
      result.toolbarPosition = null;
    } else {
      result.toolbarPosition = {
        x: Math.min(1, Math.max(0, raw.x)),
        y: Math.min(1, Math.max(0, raw.y)),
      };
    }
  }
  if (typeof result.boardBackground !== 'string' || result.boardBackground === '') {
    result.boardBackground = '#000000';
  }
  // A path with control characters could break the child-process argument; drop it instead of
  // passing something the user cannot see. Empty means "no recognizer configured".
  if (typeof result.mathNotePythonPath !== 'string') {
    result.mathNotePythonPath = '';
  } else {
    const trimmed = result.mathNotePythonPath.trim();
    result.mathNotePythonPath = hasControlCharacter(trimmed) ? '' : trimmed;
  }
  if (!['ollama', 'mathnote', 'disabled'].includes(result.recognitionEngine)) {
    result.recognitionEngine = 'ollama';
  }
  try {
    const url = new URL(typeof result.ollamaBaseUrl === 'string' ? result.ollamaBaseUrl : '');
    const path = url.pathname.replace(/\/+$/, '');
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    const port = !url.port || url.port === '11434';
    if (!local || !port || (path !== '' && path !== '/v1')) throw new Error('invalid local URL');
    result.ollamaBaseUrl = url.origin;
  } catch {
    result.ollamaBaseUrl = 'http://127.0.0.1:11434';
  }
  // This release is validated only with Q8 on the 6 GiB RTX 2060. Do not silently select or
  // download another model from a saved setting.
  if (result.ollamaModel !== 'glm-ocr:q8_0') result.ollamaModel = 'glm-ocr:q8_0';
  if (typeof result.ollamaTimeoutSeconds !== 'number' || !Number.isFinite(result.ollamaTimeoutSeconds)) {
    result.ollamaTimeoutSeconds = 180;
  } else {
    result.ollamaTimeoutSeconds = Math.min(600, Math.max(5, Math.round(result.ollamaTimeoutSeconds)));
  }
  if (typeof result.ollamaMaxRetries !== 'number' || !Number.isFinite(result.ollamaMaxRetries)) {
    result.ollamaMaxRetries = 3;
  } else {
    result.ollamaMaxRetries = Math.min(3, Math.max(1, Math.round(result.ollamaMaxRetries)));
  }
  // Palette: a non-array or wrong-length value is reset to the defaults. In an eight-entry
  // array, only the invalid hex entries are replaced, each with the default at its index.
  if (!Array.isArray(result.paletteColors) || result.paletteColors.length !== 8) {
    result.paletteColors = [...DEFAULT_PALETTE_COLORS];
  } else {
    result.paletteColors = result.paletteColors.map((c, i) =>
      typeof c === 'string' && HEX6.test(c) ? c : DEFAULT_PALETTE_COLORS[i],
    );
  }
  return result;
}
