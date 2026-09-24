import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, FolderSearch, Search, X } from 'lucide-react';
import { CATEGORY_LABELS } from '@shared/categories';
import { formatBytes, formatCount, formatDateTime, formatDuration, formatPercent, plural } from '@shared/format';
import type { FileCategory, FileEntry, FilePage, ScanOptions, ScanSummary, SearchResult, TypeBreakdown } from '@shared/types';
import { api, errorMessage } from '../api';
import { DetailsPanel } from '../components/DetailsPanel';
import { FolderTree, type Selection } from '../components/FolderTree';
import { LargeFilesTable } from '../components/LargeFilesTable';
import { ScanProgress } from '../components/ScanProgress';
import { volumeName } from '../components/VolumeUsageCard';
import { Checkbox, Chip, EmptyState, Loading, Meter, Notice, StatusBadge, Tabs } from '../components/ui';
import { currentSummary, useApp, type AnalyzeTab } from '../store';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function ScanControls({ disabled }: { disabled: boolean }) {
  const volumes = useApp((state) => state.volumes);
  const settings = useApp((state) => state.settings);
  const scan = useApp((state) => state.scan);
  const startScan = useApp((state) => state.startScan);
  const previous = currentSummary(scan)?.options;
  const [options, setOptions] = useState<ScanOptions>(() => ({
    root: previous?.root ?? settings?.defaultVolume ?? 'C:\\',
    includeHidden: previous?.includeHidden ?? false,
    includeUserFolders: previous?.includeUserFolders ?? true,
  }));
  const candidates = volumes.filter((volume) => volume.type === 'fixed' || volume.type === 'removable');
  const hasResults = scan.status === 'ready';
  const runningOptions = scan.status === 'running' ? scan.options : null;

  // A scan started elsewhere (Overview, "include hidden" shortcut) updates the form.
  useEffect(() => {
    if (runningOptions) setOptions(runningOptions);
  }, [runningOptions]);

  return (
    <section className="card" aria-label="Opções da análise">
      <div className="row" style={{ gap: 18 }}>
        <label className="row" style={{ gap: 8 }}>
          <span className="field-label">Disco</span>
          <select
            className="select"
            value={options.root}
            disabled={disabled}
            onChange={(event) => setOptions({ ...options, root: event.target.value })}
          >
            {candidates.map((volume) => (
              <option key={volume.root} value={volume.root}>
                {volumeName(volume)} — {formatBytes(volume.usedBytes)} usados
              </option>
            ))}
          </select>
        </label>
        <Checkbox
          checked={options.includeHidden}
          disabled={disabled}
          onChange={(includeHidden) => setOptions({ ...options, includeHidden })}
          label="Incluir arquivos ocultos"
        />
        <Checkbox
          checked={options.includeUserFolders}
          disabled={disabled}
          onChange={(includeUserFolders) => setOptions({ ...options, includeUserFolders })}
          label="Analisar pastas pessoais"
        />
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={disabled} onClick={() => void startScan(options)}>
          {hasResults ? 'Analisar novamente' : 'Iniciar análise'}
        </button>
      </div>
      <p className="subtle" style={{ marginTop: 10 }}>
        Arquivos ocultos incluem pastas como AppData e ProgramData e arquivos do sistema como o de paginação. A análise apenas lê
        informações e pode levar alguns minutos em discos grandes.
      </p>
    </section>
  );
}

function SummaryCard({ summary }: { summary: ScanSummary }) {
  const startScan = useApp((state) => state.startScan);
  const hidden = summary.skippedHidden;
  const hiddenSkipped = !summary.options.includeHidden && hidden.files + hidden.folders > 0;
  const difference = summary.volume ? summary.volume.usedBytes - summary.totalSize : null;
  return (
    <section className="card stack" aria-label="Resumo da análise" style={{ gap: 12 }}>
      <div className="row">
        <h2>Resultado da análise de {summary.root}</h2>
        <StatusBadge status={summary.status} />
        <span className="spacer" />
        <span className="subtle">
          {formatDateTime(summary.finishedAt)} · levou {formatDuration(summary.finishedAt - summary.startedAt)}
        </span>
      </div>
      <div className="stats">
        <div>
          <div className="stat-label">Analisado (em disco)</div>
          <div className="stat-value">{formatBytes(summary.totalSize)}</div>
        </div>
        <div>
          <div className="stat-label">Arquivos</div>
          <div className="stat-value">{formatCount(summary.fileCount)}</div>
        </div>
        <div>
          <div className="stat-label">Pastas</div>
          <div className="stat-value">{formatCount(summary.folderCount)}</div>
        </div>
        <div>
          <div className="stat-label">Pastas sem acesso</div>
          <div className="stat-value">{formatCount(summary.inaccessibleCount)}</div>
        </div>
      </div>
      {summary.status === 'cancelled' && (
        <Notice kind="warn">A análise foi cancelada. Os números abaixo são parciais.</Notice>
      )}
      {summary.inaccessibleCount > 0 && (
        <Notice kind="neutral">
          {plural(summary.inaccessibleCount, 'pasta não pôde ser analisada', 'pastas não puderam ser analisadas')} porque o Windows
          negou acesso. O LimpaC não tenta contornar permissões.
        </Notice>
      )}
      {hiddenSkipped && (
        <Notice kind="neutral">
          Itens ocultos não incluídos: {plural(hidden.folders, 'pasta', 'pastas')} e {plural(hidden.files, 'arquivo', 'arquivos')}
          {hidden.fileBytes > 0 && ` (${formatBytes(hidden.fileBytes)} só nos arquivos)`}, como AppData, ProgramData e o arquivo de
          paginação. Muitos programas guardam dados e caches grandes nessas pastas.
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn small"
              onClick={() => void startScan({ ...summary.options, includeHidden: true })}
            >
              Analisar novamente incluindo ocultos
            </button>
          </div>
        </Notice>
      )}
      {summary.skippedUserFolders && <Notice kind="neutral">As pastas dos usuários não foram incluídas nesta análise.</Notice>}
      {summary.limitedMetadata && (
        <Notice kind="warn">Modo de compatibilidade: tamanhos em disco, ocultos e links de nuvem podem não ser detectados.</Notice>
      )}
      {difference !== null && summary.status === 'completed' && (
        <details>
          <summary className="btn link">Por que o total pode ser diferente do espaço usado no disco?</summary>
          <div className="muted" style={{ marginTop: 8, fontSize: 13.5 }}>
            <p>
              O Windows informa {formatBytes(summary.volume!.usedBytes)} usados em {summary.root}; a análise encontrou{' '}
              {formatBytes(summary.totalSize)}
              {difference > 0 ? ` (${formatBytes(difference)} a menos)` : ''}. A diferença costuma vir de:
            </p>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>pastas sem permissão de leitura e arquivos ocultos ou de sistema não incluídos;</li>
              <li>pontos de restauração e dados internos do sistema de arquivos;</li>
              <li>
                links físicos contados uma única vez
                {summary.hardLinkDuplicateBytes > 0 && ` (${formatBytes(summary.hardLinkDuplicateBytes)} não foram contados em dobro)`};
              </li>
              <li>atalhos de pasta (links e junções) que não são seguidos, arquivos compactados e arquivos só na nuvem.</li>
            </ul>
          </div>
        </details>
      )}
    </section>
  );
}

const SIZE_FILTERS = [
  { label: 'Mais de 100 MB', value: 100 * MB },
  { label: 'Mais de 1 GB', value: GB },
];

const CATEGORY_FILTERS: FileCategory[] = ['video', 'image', 'archive', 'installer'];

function LargeFilesView({
  scanId,
  selected,
  onSelect,
}: {
  scanId: string;
  selected: Selection | null;
  onSelect(selection: Selection): void;
}) {
  const view = useApp((state) => state.analyze);
  const openAnalyze = useApp((state) => state.openAnalyze);
  const addToTransfer = useApp((state) => state.addToTransfer);
  const toast = useApp((state) => state.toast);
  const [page, setPage] = useState<FilePage | null>(null);
  const [limit, setLimit] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, FileEntry>>({});
  const [underName, setUnderName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.scan
      .largeFiles({
        scanId,
        category: view.category ?? undefined,
        minSize: view.minSize ?? undefined,
        underFolderId: view.underFolderId ?? undefined,
        limit,
      })
      .then((result) => !cancelled && setPage(result))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [scanId, view.category, view.minSize, view.underFolderId, limit]);

  useEffect(() => {
    if (view.underFolderId === null) return setUnderName(null);
    api.scan
      .folder({ scanId, folderId: view.underFolderId, limit: 1 })
      .then((result) => setUnderName(result.folder.path))
      .catch(() => setUnderName(null));
  }, [scanId, view.underFolderId]);

  const checkedList = Object.values(checked);
  const addChecked = async () => {
    const classes = await api.transfer.classify(checkedList.map((file) => file.path));
    const eligible = checkedList.filter((_, index) => classes[index].eligible);
    addToTransfer(eligible);
    const blocked = checkedList.length - eligible.length;
    toast(
      eligible.length ? 'success' : 'error',
      `${plural(eligible.length, 'arquivo adicionado', 'arquivos adicionados')} à lista para mover.` +
        (blocked ? ` ${plural(blocked, 'arquivo protegido foi ignorado', 'arquivos protegidos foram ignorados')}.` : ''),
    );
    setChecked({});
  };

  return (
    <div>
      <div className="row" style={{ padding: '12px 16px' }}>
        <div className="chips" role="group" aria-label="Filtrar por tamanho">
          {SIZE_FILTERS.map((filter) => (
            <Chip
              key={filter.value}
              pressed={view.minSize === filter.value}
              onClick={() => openAnalyze({ minSize: view.minSize === filter.value ? null : filter.value })}
            >
              {filter.label}
            </Chip>
          ))}
        </div>
        <div className="chips" role="group" aria-label="Filtrar por tipo">
          {CATEGORY_FILTERS.map((category) => (
            <Chip
              key={category}
              pressed={view.category === category}
              onClick={() => openAnalyze({ category: view.category === category ? null : category })}
            >
              {CATEGORY_LABELS[category]}
            </Chip>
          ))}
          {view.category && !CATEGORY_FILTERS.includes(view.category) && (
            <Chip pressed onClick={() => openAnalyze({ category: null })}>
              {CATEGORY_LABELS[view.category]}
            </Chip>
          )}
        </div>
        {view.minSize !== null && !SIZE_FILTERS.some((filter) => filter.value === view.minSize) && (
          <Chip pressed onClick={() => openAnalyze({ minSize: null })}>
            Mais de {formatBytes(view.minSize)}
          </Chip>
        )}
      </div>
      {underName && (
        <div style={{ padding: '0 16px 12px' }}>
          <span className="badge info">
            Somente em {underName}
            <button
              type="button"
              className="btn link"
              aria-label="Remover filtro de pasta"
              onClick={() => openAnalyze({ underFolderId: null })}
            >
              <X size={13} aria-hidden />
            </button>
          </span>
        </div>
      )}
      {error ? (
        <div style={{ padding: 16 }}>
          <Notice kind="danger">{error}</Notice>
        </div>
      ) : !page ? (
        <Loading />
      ) : page.items.length === 0 ? (
        <EmptyState icon={<FolderSearch size={26} />} title="Nenhum arquivo com esses filtros" />
      ) : (
        <>
          {checkedList.length > 0 && (
            <div className="row" style={{ padding: '0 16px 12px' }}>
              <span className="muted">
                {plural(checkedList.length, 'selecionado', 'selecionados')} ·{' '}
                {formatBytes(checkedList.reduce((sum, file) => sum + file.size, 0))}
              </span>
              <button type="button" className="btn small primary" onClick={() => void addChecked()}>
                Adicionar à lista para mover
              </button>
              <button type="button" className="btn small ghost" onClick={() => setChecked({})}>
                Limpar seleção
              </button>
            </div>
          )}
          <LargeFilesTable
            items={page.items}
            caption="Maiores arquivos encontrados"
            selectedPath={selected?.kind === 'file' ? selected.file.path : null}
            onSelect={(file) => onSelect({ kind: 'file', file })}
            selection={{
              isSelected: (path) => Boolean(checked[path]),
              toggle: (file, value) =>
                setChecked((current) => {
                  const next = { ...current };
                  if (value) next[file.path] = file;
                  else delete next[file.path];
                  return next;
                }),
              toggleAll: (value) =>
                setChecked(value ? Object.fromEntries(page.items.map((file) => [file.path, file])) : {}),
            }}
          />
          <div className="table-footer">
            <span>
              {formatCount(page.items.length)} de {formatCount(page.total)}
              {page.truncated && ' · a análise guarda apenas os maiores arquivos de cada tipo'}
            </span>
            {page.items.length < page.total && (
              <button type="button" className="btn small" onClick={() => setLimit(limit + 100)}>
                Mostrar mais
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TypesView({ scanId }: { scanId: string }) {
  const openAnalyze = useApp((state) => state.openAnalyze);
  const [types, setTypes] = useState<TypeBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.scan
      .types(scanId)
      .then(setTypes)
      .catch((err) => setError(errorMessage(err)));
  }, [scanId]);
  if (error) return <Notice kind="danger">{error}</Notice>;
  if (!types) return <Loading />;
  const total = types.categories.reduce((sum, category) => sum + category.size, 0) || 1;
  return (
    <div>
      <div className="list">
        {types.categories.map((category) => (
          <button
            key={category.category}
            type="button"
            className="bar-row"
            onClick={() =>
              openAnalyze({ tab: 'files', category: category.category, minSize: null, underFolderId: null })
            }
          >
            <strong>{CATEGORY_LABELS[category.category]}</strong>
            <Meter thin value={category.size / total} label={`${CATEGORY_LABELS[category.category]}: ${formatPercent(category.size / total)}`} />
            <span className="num" style={{ textAlign: 'right' }}>
              {formatBytes(category.size)}
            </span>
            <span className="num subtle" style={{ textAlign: 'right' }}>
              {plural(category.count, 'arquivo', 'arquivos')}
            </span>
          </button>
        ))}
      </div>
      <div className="card-header" style={{ padding: '18px 16px 8px', marginBottom: 0, borderTop: '1px solid var(--border)' }}>
        <div>
          <h2>Extensões que mais ocupam espaço</h2>
          <p>“Outros” inclui arquivos de programas e do sistema, que não devem ser apagados manualmente.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <caption className="visually-hidden">Extensões de arquivo por tamanho</caption>
          <thead>
            <tr>
              <th>Extensão</th>
              <th>Tipo</th>
              <th className="right">Arquivos</th>
              <th className="right">Tamanho</th>
            </tr>
          </thead>
          <tbody>
            {types.extensions.map((extension) => (
              <tr key={extension.extension}>
                <td>{extension.extension.startsWith('(') ? extension.extension : `.${extension.extension}`}</td>
                <td className="subtle">{CATEGORY_LABELS[extension.category]}</td>
                <td className="right subtle">{formatCount(extension.count)}</td>
                <td className="right">{formatBytes(extension.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SearchResults({
  scanId,
  text,
  selected,
  onSelect,
  onOpenFolder,
}: {
  scanId: string;
  text: string;
  selected: Selection | null;
  onSelect(selection: Selection): void;
  onOpenFolder(folderId: number): void;
}) {
  const [result, setResult] = useState<SearchResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    const timer = window.setTimeout(() => {
      api.scan
        .search(scanId, text)
        .then((value) => !cancelled && setResult(value))
        .catch(() => !cancelled && setResult({ folders: [], files: [] }));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scanId, text]);
  if (!result) return <Loading text="Procurando…" />;
  if (result.folders.length === 0 && result.files.length === 0) {
    return <EmptyState icon={<Search size={24} />} title={`Nada encontrado para “${text}”`} />;
  }
  return (
    <div>
      {result.folders.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Pastas encontradas</caption>
            <thead>
              <tr>
                <th>Pastas ({result.folders.length})</th>
                <th className="right">Tamanho</th>
              </tr>
            </thead>
            <tbody>
              {result.folders.map((folder) => (
                <tr
                  key={folder.id}
                  aria-selected={selected?.kind === 'folder' && selected.folder.id === folder.id}
                  onClick={() => onSelect({ kind: 'folder', folder })}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="name-cell">
                    <div className="cell-name">
                      <FolderOpen size={16} className="folder-icon" aria-hidden />
                      <div style={{ minWidth: 0 }}>
                        <button
                          type="button"
                          className="name-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenFolder(folder.id);
                          }}
                        >
                          {folder.name}
                        </button>
                        <span className="path" title={folder.path}>
                          {folder.path}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="right">{formatBytes(folder.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.files.length > 0 && (
        <LargeFilesTable
          items={result.files}
          caption="Arquivos grandes encontrados"
          selectedPath={selected?.kind === 'file' ? selected.file.path : null}
          onSelect={(file) => onSelect({ kind: 'file', file })}
        />
      )}
    </div>
  );
}

export function Analyze() {
  const scan = useApp((state) => state.scan);
  const view = useApp((state) => state.analyze);
  const openAnalyze = useApp((state) => state.openAnalyze);
  const cancelScan = useApp((state) => state.cancelScan);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [search, setSearch] = useState('');

  const summary = scan.status === 'ready' ? scan.summary : null;
  const scanId = summary?.scanId ?? null;
  useEffect(() => setSelected(null), [scanId]);

  const tabs = useMemo(
    () =>
      [
        { value: 'folders', label: 'Pastas' },
        { value: 'files', label: 'Arquivos grandes' },
        { value: 'types', label: 'Tipos de arquivo' },
      ] satisfies { value: AnalyzeTab; label: string }[],
    [],
  );

  const openFolder = (folderId: number) => {
    setSearch('');
    openAnalyze({ tab: 'folders', folderId });
  };

  const lastSaved = scan.status === 'idle' ? scan.lastSummary : null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Analisar disco</h1>
          <p>Descubra onde o espaço está sendo usado: pastas, maiores arquivos e tipos de arquivo.</p>
        </div>
      </header>
      <div className="stack">
        <ScanControls disabled={scan.status === 'running'} />

        {scan.status === 'running' && <ScanProgress progress={scan.progress} onCancel={() => void cancelScan()} />}

        {lastSaved?.status === 'failed' && (
          <Notice kind="danger">A última análise falhou: {lastSaved.errorMessage ?? 'erro desconhecido'}. Tente novamente.</Notice>
        )}

        {scan.status === 'idle' && lastSaved?.status !== 'failed' && (
          <div className="card">
            <EmptyState icon={<FolderSearch size={30} />} title={lastSaved ? 'Os detalhes da última análise não estão carregados' : 'Nenhuma análise ainda'}>
              <p className="muted" style={{ maxWidth: 520 }}>
                {lastSaved
                  ? `A última análise (${formatDateTime(lastSaved.finishedAt)}) não fica guardada entre sessões para economizar memória. Analise novamente para navegar pelas pastas.`
                  : 'Escolha o disco e clique em “Iniciar análise”. Nada é alterado durante a análise.'}
              </p>
            </EmptyState>
          </div>
        )}

        {summary && scanId && (
          <>
            <SummaryCard summary={summary} />
            <div className="row">
              <Tabs label="Modo de visualização" value={view.tab} options={tabs} onChange={(tab) => {
                setSearch('');
                openAnalyze({ tab });
              }} />
              <span className="spacer" />
              <label className="search">
                <Search size={15} aria-hidden />
                <span className="visually-hidden">Buscar por nome</span>
                <input
                  className="input"
                  type="search"
                  placeholder="Buscar pasta ou arquivo grande"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            </div>
            <div className="analyze-layout">
              <section className="card flush" aria-label="Resultados">
                {search.trim() ? (
                  <SearchResults scanId={scanId} text={search.trim()} selected={selected} onSelect={setSelected} onOpenFolder={openFolder} />
                ) : view.tab === 'folders' ? (
                  <FolderTree scanId={scanId} folderId={view.folderId} selected={selected} onOpen={openFolder} onSelect={setSelected} />
                ) : view.tab === 'files' ? (
                  <LargeFilesView scanId={scanId} selected={selected} onSelect={setSelected} />
                ) : (
                  <TypesView scanId={scanId} />
                )}
              </section>
              <DetailsPanel
                selection={selected}
                onOpenFolder={openFolder}
                onLargeFilesHere={(folderId) => openAnalyze({ tab: 'files', underFolderId: folderId, category: null, minSize: null })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
