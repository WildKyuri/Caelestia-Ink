import { describe, it, expect } from 'vitest';
import { validateSettings, DEFAULT_PLUGIN_SETTINGS, PluginSettings } from '../src/domain/entities';

function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return { ...DEFAULT_PLUGIN_SETTINGS, ...overrides };
}

describe('validateSettings', () => {
  it('preserves valid settings unchanged', () => {
    const input = makeSettings();
    const result = validateSettings(input);
    expect(result).toEqual(input);
  });

  it('defaults invalid drawingFolder to Blackboard', () => {
    const result = validateSettings(makeSettings({ drawingFolder: 123 as any }));
    expect(result.drawingFolder).toBe('Blackboard');
  });

  it('defaults invalid newFileLocation to fixed', () => {
    const result = validateSettings(makeSettings({ newFileLocation: 'somewhere' as any }));
    expect(result.newFileLocation).toBe('fixed');
  });

  it('defaults invalid autoExportSvg to false', () => {
    const result = validateSettings(makeSettings({ autoExportSvg: 'yes' as any }));
    expect(result.autoExportSvg).toBe(false);
  });

  it('defaults invalid svgExportPath to empty string', () => {
    const result = validateSettings(makeSettings({ svgExportPath: 42 as any }));
    expect(result.svgExportPath).toBe('');
  });

  it('coerces a non-boolean showToolbarPill back to true', () => {
    for (const bad of [undefined, 0, 'yes', null] as any[]) {
      const result = validateSettings(makeSettings({ showToolbarPill: bad }));
      expect(result.showToolbarPill).toBe(true);
    }
  });

  it('preserves showToolbarPill false', () => {
    const result = validateSettings(makeSettings({ showToolbarPill: false }));
    expect(result.showToolbarPill).toBe(false);
  });

  it('preserves showToolbarPill true', () => {
    const result = validateSettings(makeSettings({ showToolbarPill: true }));
    expect(result.showToolbarPill).toBe(true);
  });

  it('preserves a valid normalized toolbarPosition', () => {
    const result = validateSettings(makeSettings({ toolbarPosition: { x: 0.25, y: 0.8 } }));
    expect(result.toolbarPosition).toEqual({ x: 0.25, y: 0.8 });
  });

  it('keeps a null toolbarPosition', () => {
    const result = validateSettings(makeSettings({ toolbarPosition: null }));
    expect(result.toolbarPosition).toBeNull();
  });

  it('resets an invalid toolbarPosition to null', () => {
    for (const bad of [undefined, 'bottom', 42, {}, { x: 0.5 }, { x: NaN, y: 0.5 }] as any[]) {
      const result = validateSettings(makeSettings({ toolbarPosition: bad }));
      expect(result.toolbarPosition).toBeNull();
    }
  });

  it('clamps toolbarPosition coordinates into 0..1', () => {
    const result = validateSettings(makeSettings({ toolbarPosition: { x: -2, y: 7 } }));
    expect(result.toolbarPosition).toEqual({ x: 0, y: 1 });
  });

  it('coerces a non-string or empty boardBackground back to #000000', () => {
    for (const bad of [undefined, 0, null, '', {}] as any[]) {
      const result = validateSettings(makeSettings({ boardBackground: bad }));
      expect(result.boardBackground).toBe('#000000');
    }
  });

  it('preserves a valid boardBackground color', () => {
    const result = validateSettings(makeSettings({ boardBackground: '#ffffff' }));
    expect(result.boardBackground).toBe('#ffffff');
  });

  it('preserves valid drawingFolder', () => {
    const result = validateSettings(makeSettings({ drawingFolder: 'MyDrawings' }));
    expect(result.drawingFolder).toBe('MyDrawings');
  });

  it('preserves valid newFileLocation current', () => {
    const result = validateSettings(makeSettings({ newFileLocation: 'current' }));
    expect(result.newFileLocation).toBe('current');
  });

  const DEFAULT_PALETTE = ['#000000', '#ffffff', '#ff0000', '#0000ff', '#00ff00', '#ffff00', '#ffa500', '#800080'];

  it('preserves a valid eight-entry paletteColors in order', () => {
    const palette = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888'];
    const result = validateSettings(makeSettings({ paletteColors: palette }));
    expect(result.paletteColors).toEqual(palette);
  });

  it('resets a non-array paletteColors to the default', () => {
    const result = validateSettings(makeSettings({ paletteColors: 'nope' as any }));
    expect(result.paletteColors).toEqual(DEFAULT_PALETTE);
  });

  it('resets a wrong-length paletteColors to the default', () => {
    const result = validateSettings(makeSettings({ paletteColors: ['#000000', '#ffffff'] as any }));
    expect(result.paletteColors).toEqual(DEFAULT_PALETTE);
  });

  it('repairs an invalid hex entry in place, preserving the valid entries', () => {
    const palette = ['#111111', 'not-a-hex', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888'];
    const result = validateSettings(makeSettings({ paletteColors: palette as any }));
    expect(result.paletteColors).toEqual([
      '#111111', DEFAULT_PALETTE[1], '#333333', '#444444', '#555555', '#666666', '#777777', '#888888',
    ]);
  });

  it('repairs a 3-digit shorthand hex entry (not 6-digit) in place', () => {
    const palette = ['#fff', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888'];
    const result = validateSettings(makeSettings({ paletteColors: palette as any }));
    expect(result.paletteColors[0]).toBe(DEFAULT_PALETTE[0]);
    expect(result.paletteColors.slice(1)).toEqual(palette.slice(1));
  });

  it('trims a valid mathNotePythonPath and clears one with control characters', () => {
    expect(validateSettings(makeSettings({ mathNotePythonPath: '  /opt/venv/bin/python \n' })).mathNotePythonPath)
      .toBe('/opt/venv/bin/python');
    // A newline inside the path would split the child-process argument; drop the value instead.
    expect(validateSettings(makeSettings({ mathNotePythonPath: '/opt/py\nthon' })).mathNotePythonPath).toBe('');
    expect(validateSettings(makeSettings({ mathNotePythonPath: 42 as any })).mathNotePythonPath).toBe('');
    expect(validateSettings(makeSettings({ mathNotePythonPath: '' })).mathNotePythonPath).toBe('');
  });

  it('accepts only known recognition engines', () => {
    expect(validateSettings(makeSettings({ recognitionEngine: 'mathnote' })).recognitionEngine).toBe('mathnote');
    expect(validateSettings(makeSettings({ recognitionEngine: 'disabled' })).recognitionEngine).toBe('disabled');
    expect(validateSettings(makeSettings({ recognitionEngine: 'remote' as any })).recognitionEngine).toBe('ollama');
  });

  it('normalizes local Ollama URLs and rejects external hosts or ports', () => {
    expect(validateSettings(makeSettings({ ollamaBaseUrl: 'http://localhost:11434/' })).ollamaBaseUrl)
      .toBe('http://localhost:11434');
    expect(validateSettings(makeSettings({ ollamaBaseUrl: 'https://example.com/v1' })).ollamaBaseUrl)
      .toBe('http://127.0.0.1:11434');
    expect(validateSettings(makeSettings({ ollamaBaseUrl: 'http://127.0.0.1:9999/v1' })).ollamaBaseUrl)
      .toBe('http://127.0.0.1:11434');
    expect(validateSettings(makeSettings({ ollamaBaseUrl: 'http://127.0.0.1:11434/v1' })).ollamaBaseUrl)
      .toBe('http://127.0.0.1:11434');
  });

  it('keeps the tested Q8 model and clamps timeout and retries', () => {
    const result = validateSettings(makeSettings({
      ollamaModel: 'another-model',
      ollamaTimeoutSeconds: 900,
      ollamaMaxRetries: 9,
    }));
    expect(result.ollamaModel).toBe('glm-ocr:q8_0');
    expect(result.ollamaTimeoutSeconds).toBe(600);
    expect(result.ollamaMaxRetries).toBe(3);
    expect(validateSettings(makeSettings({ ollamaTimeoutSeconds: 1, ollamaMaxRetries: 0 })))
      .toMatchObject({ ollamaTimeoutSeconds: 5, ollamaMaxRetries: 1 });
  });

  it('does not reintroduce removed drawing-defaults/smoothing/streamline fields', () => {
    const result = validateSettings(makeSettings()) as any;
    expect(result.smoothing).toBeUndefined();
    expect(result.streamline).toBeUndefined();
    expect(result.defaultPenSize).toBeUndefined();
    expect(result.defaultHighlighterSize).toBeUndefined();
    expect(result.defaultEraserSize).toBeUndefined();
    expect(result.defaultTool).toBeUndefined();
  });
});
