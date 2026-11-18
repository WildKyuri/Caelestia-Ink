import { PluginSettingTab, App, Setting } from 'obsidian';
import type { PluginSettings } from '../domain/entities';
import type BlackboardPlugin from '../main';

/**
 * Structural subset of Obsidian 1.13's SettingDefinitionItem group shape. Typings stay
 * pinned to 1.12 while minAppVersion (1.6.6) predates the declarative renderer, so the
 * shape is declared locally; Obsidian 1.13+ consumes it at runtime for settings search.
 */
interface SettingDefinitionGroupSubset {
  type: 'group';
  heading: string;
  items: Array<{
    name: string;
    desc?: string;
    visible?: () => boolean;
    control:
      | { type: 'text' | 'toggle' | 'color'; key: string }
      | { type: 'dropdown'; key: string; options: Record<string, string> };
  }>;
}

export class BlackboardSettingTab extends PluginSettingTab {
  private plugin: BlackboardPlugin;

  constructor(app: App, plugin: BlackboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Declarative mirror of display() for Obsidian 1.13+ settings search. display() is
   * kept (minAppVersion predates 1.13); on older versions it remains the only renderer.
   * Both read/write the same PluginSettings through get/setControlValue below.
   */
  getSettingDefinitions(): SettingDefinitionGroupSubset[] {
    return [
      {
        type: 'group',
        heading: 'File storage',
        items: [
          {
            name: 'Drawing folder',
            desc: 'Folder for new drawing files',
            control: { type: 'text', key: 'drawingFolder' },
          },
          {
            name: 'New file location',
            desc: 'Where to create new drawing files',
            control: {
              type: 'dropdown',
              key: 'newFileLocation',
              options: { fixed: 'Fixed folder', current: 'Same as active file' },
            },
          },
          {
            name: 'Auto-export SVG',
            desc: 'Export an SVG copy of each drawing whenever it changes',
            control: { type: 'toggle', key: 'autoExportSvg' },
          },
          {
            name: 'SVG export path',
            desc: 'Folder for exported SVG files (empty = same folder as drawing)',
            visible: () => this.plugin.settings.autoExportSvg,
            control: { type: 'text', key: 'svgExportPath' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Appearance',
        items: [
          {
            name: 'Board background',
            desc: 'Color painted behind every drawing (Canvas node, Markdown embed, and the ' +
              'full-page view). Default black; set white for a whiteboard.',
            control: { type: 'color', key: 'boardBackground' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Toolbar palette',
        items: this.plugin.settings.paletteColors.map((_, i) => ({
          name: `Color ${i + 1}`,
          desc: `Swatch ${i + 1} in the toolbar color popover`,
          control: { type: 'color' as const, key: `paletteColors.${i}` },
        })),
      },
      {
        type: 'group',
        heading: 'Toolbar',
        items: [
          {
            name: 'Show toolbar pill',
            desc:
              'Show the collapsed pen-icon pill on Canvas with no active drawing, so there is ' +
              'always a button to add one. Turn off to hide it until a drawing is active.',
            control: { type: 'toggle', key: 'showToolbarPill' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Recognition',
        items: [
          {
            name: 'Recognition engine',
            desc: 'Local backend used only when Convert is pressed.',
            control: {
              type: 'dropdown',
              key: 'recognitionEngine',
              options: { ollama: 'Ollama (GLM-OCR)', mathnote: 'MathNote (experimental)', disabled: 'Disabled' },
            },
          },
          {
            name: 'Ollama endpoint',
            desc: 'Only localhost or 127.0.0.1 on port 11434 is accepted.',
            visible: () => this.plugin.settings.recognitionEngine === 'ollama',
            control: { type: 'text', key: 'ollamaBaseUrl' },
          },
          {
            name: 'Ollama model',
            desc: 'Fixed to the locally validated glm-ocr:q8_0 model.',
            visible: () => this.plugin.settings.recognitionEngine === 'ollama',
            control: { type: 'text', key: 'ollamaModel' },
          },
          {
            name: 'Ollama timeout seconds',
            visible: () => this.plugin.settings.recognitionEngine === 'ollama',
            control: { type: 'text', key: 'ollamaTimeoutSeconds' },
          },
          {
            name: 'Ollama retries',
            visible: () => this.plugin.settings.recognitionEngine === 'ollama',
            control: { type: 'text', key: 'ollamaMaxRetries' },
          },
          {
            name: 'MathNote Python path',
            desc:
              'Absolute path of a Python 3.12 interpreter with mathnote-ocr installed ' +
              '(desktop only). Empty disables handwriting recognition.',
            visible: () => this.plugin.settings.recognitionEngine === 'mathnote',
            control: { type: 'text', key: 'mathNotePythonPath' },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key.startsWith('paletteColors.')) {
      return this.plugin.settings.paletteColors[Number(key.split('.')[1])];
    }
    return this.plugin.settings[key as keyof PluginSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key.startsWith('paletteColors.')) {
      this.plugin.settings.paletteColors[Number(key.split('.')[1])] = value as string;
    } else if (key === 'ollamaTimeoutSeconds' || key === 'ollamaMaxRetries') {
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = Number(value);
    } else {
      // Keys come exclusively from getSettingDefinitions() above, so this write is
      // constrained to known PluginSettings members.
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    }
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('File storage').setHeading();

    new Setting(containerEl)
      .setName('Drawing folder')
      .setDesc('Folder for new drawing files')
      .addText((text) =>
        text.setValue(this.plugin.settings.drawingFolder).onChange(async (value) => {
          this.plugin.settings.drawingFolder = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('New file location')
      .setDesc('Where to create new drawing files')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('fixed', 'Fixed folder')
          .addOption('current', 'Same as active file')
          .setValue(this.plugin.settings.newFileLocation)
          .onChange(async (value) => {
            this.plugin.settings.newFileLocation = value as 'fixed' | 'current';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auto-export SVG')
      .setDesc('Export an SVG copy of each drawing whenever it changes')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoExportSvg).onChange(async (value) => {
          this.plugin.settings.autoExportSvg = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.autoExportSvg) {
      new Setting(containerEl)
        .setName('SVG export path')
        .setDesc('Folder for exported SVG files (empty = same folder as drawing)')
        .addText((text) =>
          text.setValue(this.plugin.settings.svgExportPath).onChange(async (value) => {
            this.plugin.settings.svgExportPath = value;
            await this.plugin.saveSettings();
          }),
        );
    }

    // Appearance: the board (surface) background, separate from the toolbar palette below.
    new Setting(containerEl).setName('Appearance').setHeading();

    new Setting(containerEl)
      .setName('Board background')
      .setDesc(
        'Color painted behind every drawing (Canvas node, Markdown embed, and the ' +
          'full-page view). Default black; set white for a whiteboard.',
      )
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.settings.boardBackground).onChange(async (value) => {
          this.plugin.settings.boardBackground = value;
          await this.plugin.saveSettings();
        }),
      );

    // Toolbar palette: the eight controls map 1:1 to the color-popover swatches, in
    // display order (left-to-right, top-to-bottom).
    new Setting(containerEl).setName('Toolbar palette').setHeading();
    for (let i = 0; i < this.plugin.settings.paletteColors.length; i++) {
      new Setting(containerEl)
        .setName(`Color ${i + 1}`)
        .setDesc(`Swatch ${i + 1} in the toolbar color popover`)
        .addColorPicker((picker) =>
          picker.setValue(this.plugin.settings.paletteColors[i]).onChange(async (value) => {
            this.plugin.settings.paletteColors[i] = value;
            await this.plugin.saveSettings();
          }),
        );
    }

    // Recognition runs only on demand. Ollama is restricted to the loopback interface and the
    // MathNote fallback starts only the explicitly configured local interpreter.
    new Setting(containerEl).setName('Recognition').setHeading();

    new Setting(containerEl)
      .setName('Recognition engine')
      .setDesc('Runs only when Convertir a nota is pressed. No background OCR is performed.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('ollama', 'Ollama (GLM-OCR)')
          .addOption('mathnote', 'MathNote (experimental)')
          .addOption('disabled', 'Disabled')
          .setValue(this.plugin.settings.recognitionEngine)
          .onChange(async (value) => {
            this.plugin.settings.recognitionEngine = value as PluginSettings['recognitionEngine'];
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.recognitionEngine === 'ollama') {
      new Setting(containerEl)
        .setName('Ollama endpoint')
        .setDesc('Local endpoint only. External hosts and ports other than 11434 are rejected.')
        .addText((text) =>
          text
            .setPlaceholder('http://127.0.0.1:11434')
            .setValue(this.plugin.settings.ollamaBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.ollamaBaseUrl = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Model')
        .setDesc('Fixed to glm-ocr:q8_0 for the validated RTX 2060 configuration.');

      new Setting(containerEl)
        .setName('Timeout')
        .setDesc('Maximum seconds per Ollama request.')
        .addSlider((slider) =>
          slider
            .setLimits(30, 300, 30)
            .setValue(this.plugin.settings.ollamaTimeoutSeconds)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.ollamaTimeoutSeconds = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Retries')
        .setDesc('Maximum attempts after a temporary timeout or server error.')
        .addSlider((slider) =>
          slider
            .setLimits(1, 3, 1)
            .setValue(this.plugin.settings.ollamaMaxRetries)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.ollamaMaxRetries = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    if (this.plugin.settings.recognitionEngine === 'mathnote') {
      new Setting(containerEl)
        .setName('MathNote Python path')
        .setDesc(
          'Absolute path of a Python 3.12 interpreter with mathnote-ocr installed ' +
            '(desktop only). Empty disables MathNote recognition.',
        )
        .addText((text) =>
          text
            .setPlaceholder('/home/you/.venvs/mathnote/bin/python')
            .setValue(this.plugin.settings.mathNotePythonPath)
            .onChange(async (value) => {
              this.plugin.settings.mathNotePythonPath = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    // Toolbar behaviour (distinct from the palette colors above).
    new Setting(containerEl).setName('Toolbar').setHeading();

    new Setting(containerEl)
      .setName('Show toolbar pill')
      .setDesc(
        'Show the collapsed pen-icon pill on Canvas with no active drawing, so there is ' +
          'always a button to add one. Turn off to hide it until a drawing is active.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showToolbarPill).onChange(async (value) => {
          this.plugin.settings.showToolbarPill = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
