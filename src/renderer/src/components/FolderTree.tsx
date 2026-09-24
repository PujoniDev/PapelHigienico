import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Files, FolderOpen, FolderX } from 'lucide-react';
import { formatBytes, formatCount, formatDate, formatPercent, plural } from '@shared/format';
import type { FileEntry, FolderEntry, FolderPage } from '@shared/types';
import { api, errorMessage } from '../api';
import { LargeFilesTable } from './LargeFilesTable';
import { Loading, Meter, Notice } from './ui';

const PAGE = 200;

export type Selection = { kind: 'folder'; folder: FolderEntry } | { kind: 'file'; file: FileEntry };

function FolderBadges({ folder }: { folder: FolderEntry }) {
  return (
    <>
      {folder.flags.inaccessible && <span className="tag">Sem acesso</span>}
      {!folder.flags.inaccessible && folder.flags.partial && <span className="tag">Parcial</span>}
      {folder.flags.cloud && <span className="tag">Nuvem</span>}
    </>
  );
}

export function FolderTree({
  scanId,
  folderId,
  selected,
  onOpen,
  onSelect,
}: {
  scanId: string;
  folderId: number;
  selected: Selection | null;
  onOpen(folderId: number): void;
  onSelect(selection: Selection): void;
}) {
  const [page, setPage] = useState<FolderPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPage(null);
    setError(null);
    setFiles(null);
    setFilesOpen(false);
    api.scan
      .folder({ scanId, folderId, offset: 0, limit: PAGE })
      .then((result) => !cancelled && setPage(result))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [scanId, folderId]);

  const loadMore = useCallback(async () => {
    if (!page) return;
    setLoadingMore(true);
    try {
      const next = await api.scan.folder({ scanId, folderId, offset: page.children.length, limit: PAGE });
      setPage({ ...page, children: [...page.children, ...next.children] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [page, scanId, folderId]);

  const toggleFiles = async () => {
    const open = !filesOpen;
    setFilesOpen(open);
    if (open && !files) {
      try {
        setFiles(await api.scan.folderFiles(scanId, folderId));
      } catch (err) {
        setFilesError(errorMessage(err));
      }
    }
  };

  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <Notice kind="danger">{error}</Notice>
      </div>
    );
  }
  if (!page) return <Loading />;

  const parentSize = page.folder.size || 1;
  const selectedFolderId = selected?.kind === 'folder' ? selected.folder.id : null;

  return (
    <div>
      <nav className="breadcrumb" aria-label="Caminho da pasta" style={{ padding: '12px 16px' }}>
        {page.breadcrumb.map((crumb, index) => {
          const last = index === page.breadcrumb.length - 1;
          return (
            <span key={crumb.id} className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
              {index > 0 && <ChevronRight size={14} className="sep" aria-hidden />}
              {last ? (
                <span aria-current="location" title={crumb.name}>
                  {crumb.name}
                </span>
              ) : (
                <button type="button" onClick={() => onOpen(crumb.id)} title={crumb.name}>
                  {crumb.name}
                </button>
              )}
            </span>
          );
        })}
        <span className="spacer" />
        <span className="subtle num">
          {formatBytes(page.folder.size)} · {plural(page.folder.fileCount, 'arquivo', 'arquivos')}
        </span>
      </nav>

      {page.folder.flags.inaccessible && (
        <div style={{ padding: '0 16px 12px' }}>
          <Notice kind="warn">O Windows negou acesso a esta pasta. O LimpaC não tenta contornar permissões.</Notice>
        </div>
      )}

      {page.totalChildren === 0 && page.directFiles.count === 0 ? (
        <div className="empty">
          <FolderX size={26} aria-hidden />
          <h3>Pasta vazia ou sem conteúdo analisado</h3>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Subpastas de {page.folder.path}, da maior para a menor</caption>
            <thead>
              <tr>
                <th>Nome</th>
                <th className="bar-cell">Parte desta pasta</th>
                <th className="right">Tamanho</th>
                <th className="right">Arquivos</th>
                <th>Modificada</th>
              </tr>
            </thead>
            <tbody>
              {page.children.map((folder) => (
                <tr
                  key={folder.id}
                  aria-selected={selectedFolderId === folder.id}
                  onClick={() => onSelect({ kind: 'folder', folder })}
                  onDoubleClick={() => onOpen(folder.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="name-cell">
                    <div className="cell-name">
                      <FolderOpen size={16} className="folder-icon" aria-hidden />
                      <button
                        type="button"
                        className="name-button"
                        title={`Abrir ${folder.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect({ kind: 'folder', folder });
                          onOpen(folder.id);
                        }}
                      >
                        {folder.name}
                      </button>
                      <FolderBadges folder={folder} />
                    </div>
                  </td>
                  <td className="bar-cell">
                    <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Meter thin value={folder.size / parentSize} label={`${folder.name}: ${formatPercent(folder.size / parentSize)}`} />
                      </div>
                      <span className="subtle num" style={{ width: 42, textAlign: 'right' }}>
                        {formatPercent(folder.size / parentSize)}
                      </span>
                    </div>
                  </td>
                  <td className="right">{formatBytes(folder.size)}</td>
                  <td className="right subtle">{formatCount(folder.fileCount)}</td>
                  <td className="num subtle">{formatDate(folder.modifiedMs)}</td>
                </tr>
              ))}
              {page.directFiles.count > 0 && (
                <tr onClick={() => void toggleFiles()} style={{ cursor: 'pointer' }}>
                  <td className="name-cell">
                    <div className="cell-name">
                      <Files size={16} aria-hidden />
                      <button
                        type="button"
                        className="name-button"
                        aria-expanded={filesOpen}
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleFiles();
                        }}
                      >
                        {filesOpen ? 'Ocultar' : 'Mostrar'} arquivos desta pasta ({formatCount(page.directFiles.count)})
                      </button>
                    </div>
                  </td>
                  <td className="bar-cell">
                    <Meter thin value={page.directFiles.size / parentSize} label="Arquivos desta pasta" />
                  </td>
                  <td className="right">{formatBytes(page.directFiles.size)}</td>
                  <td className="right subtle">{formatCount(page.directFiles.count)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {page.children.length < page.totalChildren && (
        <div className="table-footer">
          <span>
            Mostrando {formatCount(page.children.length)} de {formatCount(page.totalChildren)} pastas
          </span>
          <button type="button" className="btn small" disabled={loadingMore} onClick={() => void loadMore()}>
            Mostrar mais
          </button>
        </div>
      )}

      {filesOpen && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <div className="card-header" style={{ padding: '14px 16px 0', marginBottom: 8 }}>
            <div>
              <h2>Arquivos diretamente em {page.folder.name}</h2>
              <p>Lidos agora do disco, do maior para o menor (até 500).</p>
            </div>
          </div>
          {filesError ? (
            <div style={{ padding: 16 }}>
              <Notice kind="danger">{filesError}</Notice>
            </div>
          ) : !files ? (
            <Loading />
          ) : (
            <LargeFilesTable
              items={files}
              showFolder={false}
              caption={`Arquivos em ${page.folder.path}`}
              selectedPath={selected?.kind === 'file' ? selected.file.path : null}
              onSelect={(file) => onSelect({ kind: 'file', file })}
            />
          )}
        </div>
      )}
    </div>
  );
}
