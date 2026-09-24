import type { ReactNode } from 'react';
import { File, FileArchive, FileImage, FileText, FileVideo, Music, Package, Disc } from 'lucide-react';
import { CATEGORY_LABELS } from '@shared/categories';
import { formatBytes, formatDate } from '@shared/format';
import type { FileCategory, FileEntry } from '@shared/types';
import { Checkbox, PathText } from './ui';

const ICONS: Record<FileCategory, typeof File> = {
  video: FileVideo,
  image: FileImage,
  audio: Music,
  document: FileText,
  archive: FileArchive,
  installer: Package,
  diskImage: Disc,
  other: File,
};

export function FileIcon({ category }: { category: FileCategory }) {
  const Icon = ICONS[category];
  return <Icon size={16} aria-hidden />;
}

export interface FileSelection {
  isSelected(path: string): boolean;
  toggle(file: FileEntry, selected: boolean): void;
  toggleAll(selected: boolean): void;
  isDisabled?(file: FileEntry): boolean;
}

export function LargeFilesTable({
  items,
  selectedPath,
  onSelect,
  selection,
  showFolder = true,
  caption,
  renderNote,
}: {
  items: FileEntry[];
  selectedPath?: string | null;
  onSelect?(file: FileEntry): void;
  selection?: FileSelection;
  showFolder?: boolean;
  caption: string;
  renderNote?(file: FileEntry): ReactNode;
}) {
  const selectable = items.filter((file) => !selection?.isDisabled?.(file));
  const allSelected = selectable.length > 0 && selectable.every((file) => selection?.isSelected(file.path));
  const someSelected = selectable.some((file) => selection?.isSelected(file.path));
  return (
    <div className="table-wrap">
      <table className="table fixed">
        <caption className="visually-hidden">{caption}</caption>
        <colgroup>
          {selection && <col style={{ width: 40 }} />}
          <col />
          <col style={{ width: 100 }} />
          <col style={{ width: 96 }} />
        </colgroup>
        <thead>
          <tr>
            {selection && (
              <th className="check">
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && someSelected}
                  onChange={(checked) => selection.toggleAll(checked)}
                  label="Selecionar todos os arquivos visíveis"
                  hideLabel
                  disabled={selectable.length === 0}
                />
              </th>
            )}
            <th>Nome</th>
            <th>Modificado</th>
            <th className="right">Tamanho</th>
          </tr>
        </thead>
        <tbody>
          {items.map((file) => {
            const disabled = selection?.isDisabled?.(file) ?? false;
            return (
              <tr
                key={file.path}
                aria-selected={selectedPath === file.path}
                onClick={() => onSelect?.(file)}
                style={{ cursor: onSelect ? 'pointer' : undefined }}
              >
                {selection && (
                  <td className="check" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={selection.isSelected(file.path)}
                      onChange={(checked) => selection.toggle(file, checked)}
                      label={`Selecionar ${file.name}`}
                      hideLabel
                      disabled={disabled}
                    />
                  </td>
                )}
                <td className="name-cell">
                  <div className="cell-name">
                    <FileIcon category={file.category} />
                    <span className="visually-hidden">{CATEGORY_LABELS[file.category]}</span>
                    <div style={{ minWidth: 0 }}>
                      {onSelect ? (
                        <button
                          type="button"
                          className="name-button"
                          title={file.name}
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect(file);
                          }}
                        >
                          {file.name}
                        </button>
                      ) : (
                        <span className="truncate" title={file.name}>
                          {file.name}
                        </span>
                      )}
                      {showFolder && <PathText path={file.folder} />}
                      {file.cloud && <span className="tag">Nuvem</span>}
                      {renderNote?.(file)}
                    </div>
                  </div>
                </td>
                <td className="num subtle">{formatDate(file.modifiedMs)}</td>
                <td className="right">{formatBytes(file.size)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
