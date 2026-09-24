import { useEffect, useState } from 'react';
import { FolderOpen, MousePointerClick } from 'lucide-react';
import { CATEGORY_LABELS } from '@shared/categories';
import { formatBytes, formatCount, formatDateTime } from '@shared/format';
import type { TransferClassification } from '@shared/types';
import { api, errorMessage } from '../api';
import { useApp } from '../store';
import type { Selection } from './FolderTree';
import { FileIcon } from './LargeFilesTable';
import { CopyPathButton, EmptyState, Notice } from './ui';

export function DetailsPanel({
  selection,
  onOpenFolder,
  onLargeFilesHere,
}: {
  selection: Selection | null;
  onOpenFolder(folderId: number): void;
  onLargeFilesHere(folderId: number): void;
}) {
  const toast = useApp((state) => state.toast);
  const addToTransfer = useApp((state) => state.addToTransfer);
  const inTransfer = useApp((state) => (selection?.kind === 'file' ? Boolean(state.transferSelection[selection.file.path]) : false));
  const [classification, setClassification] = useState<TransferClassification | null>(null);
  const path = selection ? (selection.kind === 'folder' ? selection.folder.path : selection.file.path) : null;

  useEffect(() => {
    setClassification(null);
    if (!path) return;
    let cancelled = false;
    api.transfer
      .classify([path])
      .then(([result]) => !cancelled && setClassification(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!selection) {
    return (
      <aside className="card details sticky-panel" aria-label="Detalhes">
        <EmptyState icon={<MousePointerClick size={24} />} title="Nada selecionado">
          <p className="subtle">Clique em uma pasta ou arquivo para ver os detalhes e as ações possíveis.</p>
        </EmptyState>
      </aside>
    );
  }

  const run = (action: Promise<unknown>) => action.catch((error) => toast('error', errorMessage(error)));

  if (selection.kind === 'folder') {
    const folder = selection.folder;
    return (
      <aside className="card details sticky-panel" aria-label="Detalhes da pasta">
        <div className="cell-name">
          <FolderOpen size={18} className="folder-icon" aria-hidden />
          <h2 className="truncate" title={folder.name}>
            {folder.name}
          </h2>
        </div>
        <dl>
          <dt>Tamanho em disco</dt>
          <dd>{formatBytes(folder.size)}</dd>
          <dt>Soma dos arquivos</dt>
          <dd>{formatBytes(folder.logicalSize)}</dd>
          <dt>Arquivos</dt>
          <dd>{formatCount(folder.fileCount)}</dd>
          <dt>Subpastas</dt>
          <dd>{formatCount(folder.folderCount)}</dd>
          <dt>Modificada</dt>
          <dd>{formatDateTime(folder.modifiedMs)}</dd>
        </dl>
        <div className="full-path" title={folder.path}>
          {folder.path}
        </div>
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          {folder.flags.inaccessible && <Notice kind="warn">O Windows negou acesso a esta pasta; o tamanho real pode ser maior.</Notice>}
          {!folder.flags.inaccessible && folder.flags.partial && (
            <Notice kind="warn">Algumas subpastas não puderam ser lidas; o tamanho real pode ser maior.</Notice>
          )}
          {folder.flags.cloud && <Notice>Pasta sincronizada com a nuvem.</Notice>}
          {classification && !classification.eligible && (
            <Notice kind="neutral">
              {classification.blockedReason} O LimpaC não altera este conteúdo. Para remover programas, use a tela Aplicativos.
            </Notice>
          )}
        </div>
        <div className="actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={() => onOpenFolder(folder.id)} disabled={folder.childCount === 0 && folder.fileCount === 0}>
            Abrir esta pasta aqui
          </button>
          <button type="button" className="btn" onClick={() => onLargeFilesHere(folder.id)}>
            Ver arquivos grandes aqui
          </button>
          <button type="button" className="btn" onClick={() => void run(api.shell.openFolder(folder.path))}>
            Abrir no Explorador de Arquivos
          </button>
          <CopyPathButton path={folder.path} />
        </div>
      </aside>
    );
  }

  const file = selection.file;
  return (
    <aside className="card details sticky-panel" aria-label="Detalhes do arquivo">
      <div className="cell-name">
        <FileIcon category={file.category} />
        <h2 className="truncate" title={file.name}>
          {file.name}
        </h2>
      </div>
      <dl>
        <dt>Tamanho</dt>
        <dd>{formatBytes(file.size)}</dd>
        <dt>Tamanho em disco</dt>
        <dd>{formatBytes(file.sizeOnDisk)}</dd>
        <dt>Tipo</dt>
        <dd>
          {CATEGORY_LABELS[file.category]}
          {file.extension ? ` (.${file.extension})` : ''}
        </dd>
        <dt>Modificado</dt>
        <dd>{formatDateTime(file.modifiedMs)}</dd>
      </dl>
      <div className="full-path" title={file.path}>
        {file.path}
      </div>
      <div className="stack" style={{ gap: 8, marginTop: 12 }}>
        {file.cloud && <Notice>Arquivo da nuvem: se estiver disponível só online, não ocupa espaço neste computador.</Notice>}
        {classification && !classification.eligible && <Notice kind="neutral">Não pode ser movido: {classification.blockedReason}</Notice>}
        {classification?.eligible &&
          classification.warnings.map((warning) => (
            <Notice key={warning} kind="warn">
              {warning}
            </Notice>
          ))}
      </div>
      <div className="actions" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="btn primary"
          disabled={!classification?.eligible || inTransfer}
          onClick={() => {
            addToTransfer([file]);
            toast('success', 'Adicionado à lista. Abra "Mover arquivos" para escolher o destino.');
          }}
        >
          {inTransfer ? 'Já está na lista para mover' : 'Mover para outro disco…'}
        </button>
        <button type="button" className="btn" onClick={() => void run(api.shell.showInFolder(file.path))}>
          Mostrar no Explorador de Arquivos
        </button>
        <CopyPathButton path={file.path} />
      </div>
    </aside>
  );
}
