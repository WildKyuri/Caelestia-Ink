import { App, normalizePath, TFile } from 'obsidian';
import type { Editor } from 'obsidian';
import type { ConversionDestination, OutputAsset } from '../../domain/recognition';

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.[^.]+$/, '');
}

export class ObsidianConversionWriter {
  constructor(private app: App) {}

  plan(sourcePath: string): ConversionDestination {
    const parent = parentPath(sourcePath);
    const base = baseName(sourcePath);
    for (let index = 1; index < 10_000; index++) {
      const suffix = index === 1 ? '' : ` ${index}`;
      const stem = `${base} - convertido${suffix}`;
      const notePath = normalizePath(parent ? `${parent}/${stem}.md` : `${stem}.md`);
      const assetFolder = normalizePath(parent ? `${parent}/${stem}-assets` : `${stem}-assets`);
      if (!this.app.vault.getAbstractFileByPath(notePath) && !this.app.vault.getAbstractFileByPath(assetFolder)) {
        return { notePath, assetFolder };
      }
    }
    throw new Error('No se pudo encontrar un nombre de salida disponible.');
  }

  planInsertion(notePath: string, sourcePath: string): ConversionDestination {
    const normalizedNote = normalizePath(notePath);
    if (!normalizedNote.toLowerCase().endsWith('.md')) {
      throw new Error('El destino de inserción debe ser una nota Markdown.');
    }
    const parent = parentPath(normalizedNote);
    const note = baseName(normalizedNote);
    const source = baseName(sourcePath);
    for (let index = 1; index < 10_000; index++) {
      const suffix = index === 1 ? '' : ` ${index}`;
      const folderName = `${note} - ${source} OCR-assets${suffix}`;
      const assetFolder = normalizePath(parent ? `${parent}/${folderName}` : folderName);
      if (!this.app.vault.getAbstractFileByPath(assetFolder)) {
        return { notePath: normalizedNote, assetFolder, mode: 'append' };
      }
    }
    throw new Error('No se pudo encontrar una carpeta de recursos disponible.');
  }

  async write(destination: ConversionDestination, markdown: string, assets: readonly OutputAsset[]): Promise<void> {
    if (destination.mode === 'append') {
      await this.append(destination, markdown, assets);
      return;
    }
    if (this.app.vault.getAbstractFileByPath(destination.notePath)) {
      throw new Error(`La nota ya existe: ${destination.notePath}`);
    }
    if (assets.length === 0) {
      // Text-only notes do not create an empty asset folder or reference any resource.
      await this.app.vault.create(destination.notePath, markdown);
      return;
    }
    if (this.app.vault.getAbstractFileByPath(destination.assetFolder)) {
      throw new Error(`La carpeta de recursos ya existe: ${destination.assetFolder}`);
    }
    const paths = new Set<string>();
    for (const asset of assets) {
      const path = normalizePath(`${destination.assetFolder}/${asset.fileName}`);
      if (paths.has(path) || this.app.vault.getAbstractFileByPath(path)) {
        throw new Error(`El recurso ya existe o está duplicado: ${path}`);
      }
      paths.add(path);
    }
    await this.app.vault.createFolder(destination.assetFolder);
    for (const asset of assets) {
      const path = normalizePath(`${destination.assetFolder}/${asset.fileName}`);
      if (typeof asset.data === 'string') await this.app.vault.create(path, asset.data);
      else await this.app.vault.createBinary(path, asset.data);
    }
    // The note is written last, so it never points to resources that have not been created.
    await this.app.vault.create(destination.notePath, markdown);
  }

  private async append(
    destination: ConversionDestination,
    markdown: string,
    assets: readonly OutputAsset[],
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(destination.notePath);
    if (!(file instanceof TFile) || file.extension !== 'md') {
      throw new Error(`La nota destino ya no existe: ${destination.notePath}`);
    }
    const clean = markdown.trim();
    if (!clean) throw new Error('El reconocimiento no contiene Markdown para insertar.');

    if (assets.length > 0) await this.writeAssets(destination, assets);

    const marker = destination.idempotencyKey
      ? `<!-- caelestia-ocr:${destination.idempotencyKey} -->`
      : '';
    const editor = this.editorFor(destination.notePath);
    if (editor) {
      const current = editor.getValue();
      const addition = this.insertion(current, clean, marker);
      const lines = current.split('\n');
      const line = Math.max(0, lines.length - 1);
      editor.replaceRange(addition, { line, ch: lines[line]?.length ?? 0 });
      return;
    }

    await this.app.vault.process(file, (current) => current + this.insertion(current, clean, marker));
  }

  private editorFor(notePath: string): Editor | null {
    const active = this.app.workspace.activeEditor;
    if (active?.file?.path === notePath && active.editor) return active.editor;
    let found: Editor | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view as unknown as { file?: TFile | null; editor?: Editor };
      if (view.file?.path === notePath && view.editor) found = view.editor;
    });
    return found;
  }

  private insertion(current: string, markdown: string, marker: string): string {
    if (marker && current.includes(marker)) {
      throw new Error('Este resultado ya fue insertado en la nota destino.');
    }
    const prefix = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    const suffix = marker ? `\n\n${marker}\n` : '\n';
    return `${prefix}${markdown}${suffix}`;
  }

  private async writeAssets(
    destination: ConversionDestination,
    assets: readonly OutputAsset[],
  ): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(destination.assetFolder)) {
      throw new Error(`La carpeta de recursos ya existe: ${destination.assetFolder}`);
    }
    const paths = new Set<string>();
    for (const asset of assets) {
      const path = normalizePath(`${destination.assetFolder}/${asset.fileName}`);
      if (paths.has(path) || this.app.vault.getAbstractFileByPath(path)) {
        throw new Error(`El recurso ya existe o está duplicado: ${path}`);
      }
      paths.add(path);
    }
    await this.app.vault.createFolder(destination.assetFolder);
    for (const asset of assets) {
      const path = normalizePath(`${destination.assetFolder}/${asset.fileName}`);
      if (typeof asset.data === 'string') await this.app.vault.create(path, asset.data);
      else await this.app.vault.createBinary(path, asset.data);
    }
  }
}
