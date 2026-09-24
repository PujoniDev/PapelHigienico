import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, FilePlus2, FolderSearch, X } from 'lucide-react';
import { CATEGORY_LABELS } from '@shared/categories';
import { formatBytes, formatDateTime, formatPercent, plural } from '@shared/format';
import type {
  ConflictPolicy,
  DeleteMode,
  FileCategory,
  FileEntry,
  RemoveOriginalsResult,
  TransferClassification,
  TransferPreview,
  TransferRecord,
  UndoTransferResult,
} from '@shared/types';
import { api, errorMessage } from '../api';
import { LargeFilesTable } from '../components/LargeFilesTable';
import { OperationResult } from '../components/OperationResult';
import { suggestedFolder, TransferDestinationPicker } from '../components/TransferDestinationPicker';
import { Checkbox, Chip, Dialog, EmptyState, Loading, Meter, Notice, PathText } from '../components/ui';
import { useApp } from '../store';

const MB = 1024 * 1024;
const SIZE_OPTIONS = [50 * MB, 100 * MB, 500 * MB, 1024 * MB];
const TYPE_OPTIONS: FileCategory[] = ['video', 'image', 'document', 'archive', 'diskImage', 'audio'];

type Candidate = FileEntry & { classification: TransferClassification };

function isUnder(path: string, folder: string): boolean {
  const p = path.toLowerCase();
  const f = folder.toLowerCase().replace(/\\$/, '');
  return p === f || p.startsWith(f + '\\');
}

// ---------------------------------------------------------------------------
// Step 1: choose files and destination

function TransferSetup() {
  const scan = useApp((state) => state.scan);
  const info = useApp((state) => state.info);
  const volumes = useApp((state) => state.volumes);
  const settings = useApp((state) => state.settings);
  const selection = useApp((state) => state.transferSelection);
  const addToTransfer = useApp((state) => state.addToTransfer);
  const removeFromTransfer = useApp((state) => state.removeFromTransfer);
  const clearTransfer = useApp((state) => state.clearTransfer);
  const setOperation = useApp((state) => state.setTransferOperation);
  const openAnalyze = useApp((state) => state.openAnalyze);
  const toast = useApp((state) => state.toast);

  const scanReady = scan.status === 'ready' && scan.summary.status !== 'failed';
  const sourceRoot = scan.status === 'ready' ? scan.summary.root : (settings?.defaultVolume ?? 'C:\\');
  const sourceLetter = sourceRoot[0];
  const destinationVolumes = volumes.filter(
    (volume) => volume.root !== sourceRoot && (volume.type === 'fixed' || volume.type === 'removable'),
  );

  const [destination, setDestination] = useState<string | null>(() => {
    const last = settings?.lastDestination;
    if (last && destinationVolumes.some((volume) => last.toUpperCase().startsWith(volume.root))) return last;
    return destinationVolumes[0] ? suggestedFolder(destinationVolumes[0], sourceLetter) : null;
  });
  const [preserveStructure, setPreserveStructure] = useState(true);
  const [minSize, setMinSize] = useState(100 * MB);
  const [category, setCategory] = useState<FileCategory | null>(null);
  const [folder, setFolder] = useState<string>('personal');
  const [showBlocked, setShowBlocked] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('rename');
  const [acknowledgeSynced, setAcknowledgeSynced] = useState(false);
  const [busy, setBusy] = useState(false);

  const scanId = scan.status === 'ready' ? scan.summary.scanId : null;
  useEffect(() => {
    if (!scanId || !scanReady) return;
    let cancelled = false;
    setCandidates(null);
    (async () => {
      const page = await api.scan.largeFiles({ scanId, minSize, category: category ?? undefined, limit: 500 });
      const classes = await api.transfer.classify(page.items.map((file) => file.path));
      if (!cancelled) setCandidates(page.items.map((file, index) => ({ ...file, classification: classes[index] })));
    })().catch((error) => !cancelled && toast('error', errorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, [scanId, scanReady, minSize, category, toast]);

  const visible = useMemo(
    () =>
      (candidates ?? []).filter((file) => {
        if (!showBlocked && !file.classification.eligible) return false;
        if (folder === 'personal') return file.classification.personal;
        if (folder === 'all') return true;
        return isUnder(file.path, folder);
      }),
    [candidates, showBlocked, folder],
  );

  const selected = Object.values(selection);
  const selectedSize = selected.reduce((sum, file) => sum + file.size, 0);
  const destinationVolume = destination ? volumes.find((volume) => destination.toUpperCase().startsWith(volume.root)) : undefined;

  const pickFiles = async () => {
    try {
      const files = await api.transfer.pickFiles();
      if (files.length === 0) return;
      const classes = await api.transfer.classify(files.map((file) => file.path));
      const eligible = files.filter((_, index) => classes[index].eligible);
      addToTransfer(eligible);
      const blocked = classes.filter((classification) => !classification.eligible);
      if (blocked.length) {
        toast('error', `${plural(blocked.length, 'arquivo não pode', 'arquivos não podem')} ser movidos: ${blocked[0].blockedReason}`);
      }
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  const review = async () => {
    if (!destination) return;
    setBusy(true);
    try {
      const result = await api.transfer.preview({ files: selected.map((file) => file.path), destination, preserveStructure });
      setAcknowledgeSynced(false);
      setConflictPolicy('rename');
      if (settings && !settings.confirmTransfers && result.canProceed && result.conflicts === 0 && result.syncedCount === 0) {
        await start(result);
      } else {
        setPreview(result);
      }
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const start = async (current: TransferPreview) => {
    setBusy(true);
    try {
      const { operationId } = await api.transfer.start({
        files: current.items.filter((item) => item.eligible).map((item) => item.source),
        destination: current.destination,
        preserveStructure,
        conflictPolicy,
        acknowledgeSynced,
      });
      setPreview(null);
      clearTransfer();
      setOperation(operationId);
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const knownFolders = info?.knownFolders ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Mover arquivos para outro disco</h1>
          <p>
            Os arquivos são copiados e conferidos primeiro. Os originais só são apagados depois, se você quiser, em uma etapa
            separada.
          </p>
        </div>
      </header>

      <div className="grid-2">
        <section className="card flush" aria-labelledby="candidates-title">
          <div className="card-header">
            <div>
              <h2 id="candidates-title">Arquivos grandes em {sourceRoot.slice(0, 2)}</h2>
              <p>Somente arquivos individuais. Pastas do sistema, de programas e de jogos não aparecem aqui.</p>
            </div>
            <button type="button" className="btn small" onClick={() => void pickFiles()}>
              <FilePlus2 size={15} aria-hidden /> Adicionar arquivos…
            </button>
          </div>
          {!scanReady ? (
            <EmptyState icon={<FolderSearch size={28} />} title="Analise o disco para ver sugestões">
              <p className="muted">Ou use “Adicionar arquivos…” para escolher arquivos diretamente.</p>
              <button type="button" className="btn primary" onClick={() => openAnalyze({ tab: 'folders' })}>
                Ir para Analisar disco
              </button>
            </EmptyState>
          ) : (
            <>
              <div className="stack" style={{ padding: '14px 16px', gap: 10 }}>
                <div className="row">
                  <label className="row" style={{ gap: 6 }}>
                    <span className="subtle">Tamanho</span>
                    <select className="select" value={minSize} onChange={(event) => setMinSize(Number(event.target.value))}>
                      {SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>
                          Mais de {formatBytes(size)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="row" style={{ gap: 6 }}>
                    <span className="subtle">Pasta</span>
                    <select className="select" value={folder} onChange={(event) => setFolder(event.target.value)}>
                      <option value="personal">Todas as pastas pessoais</option>
                      {knownFolders.map((known) => (
                        <option key={known.path} value={known.path}>
                          {known.label}
                        </option>
                      ))}
                      <option value="all">Qualquer lugar</option>
                    </select>
                  </label>
                </div>
                <div className="chips" role="group" aria-label="Filtrar por tipo">
                  <Chip pressed={category === null} onClick={() => setCategory(null)}>
                    Todos
                  </Chip>
                  {TYPE_OPTIONS.map((option) => (
                    <Chip key={option} pressed={category === option} onClick={() => setCategory(category === option ? null : option)}>
                      {CATEGORY_LABELS[option]}
                    </Chip>
                  ))}
                </div>
                <Checkbox checked={showBlocked} onChange={setShowBlocked} label="Mostrar também os que não podem ser movidos" />
              </div>
              {!candidates ? (
                <Loading />
              ) : visible.length === 0 ? (
                <EmptyState icon={<FolderSearch size={24} />} title="Nenhum arquivo com esses filtros" />
              ) : (
                <div style={{ maxHeight: 560, overflow: 'auto', borderTop: '1px solid var(--border)' }}>
                  <LargeFilesTable
                    items={visible}
                    caption="Arquivos que podem ser movidos"
                    selection={{
                      isSelected: (path) => Boolean(selection[path]),
                      isDisabled: (file) => !(file as Candidate).classification.eligible,
                      toggle: (file, checked) => (checked ? addToTransfer([file]) : removeFromTransfer([file.path])),
                      toggleAll: (checked) => {
                        const eligible = visible.filter((file) => file.classification.eligible);
                        if (checked) addToTransfer(eligible);
                        else removeFromTransfer(eligible.map((file) => file.path));
                      },
                    }}
                    renderNote={(file) => {
                      const classification = (file as Candidate).classification;
                      if (!classification.eligible) return <span className="subtle">Não pode ser movido: {classification.blockedReason}</span>;
                      if (classification.synced) return <span className="tag">Sincronizado</span>;
                      return null;
                    }}
                  />
                </div>
              )}
            </>
          )}
        </section>

        <div className="stack">
          <section className="card" aria-labelledby="destination-title">
            <h2 id="destination-title" style={{ marginBottom: 12 }}>
              Para onde
            </h2>
            <TransferDestinationPicker
              volumes={destinationVolumes}
              sourceLetter={sourceLetter}
              destination={destination}
              onDestination={setDestination}
              preserveStructure={preserveStructure}
              onPreserveStructure={setPreserveStructure}
            />
          </section>

          <section className="card" aria-labelledby="summary-title">
            <div className="card-header">
              <h2 id="summary-title">Resumo</h2>
              {selected.length > 0 && (
                <button type="button" className="btn small ghost" onClick={clearTransfer}>
                  Limpar lista
                </button>
              )}
            </div>
            <div className="summary-list">
              <div>
                <span className="muted">Selecionados</span>
                <strong className="num">
                  {plural(selected.length, 'arquivo', 'arquivos')} · {formatBytes(selectedSize)}
                </strong>
              </div>
              <div>
                <span className="muted">Livre no destino</span>
                <strong className="num">{destinationVolume ? formatBytes(destinationVolume.freeBytes) : '—'}</strong>
              </div>
              <div>
                <span className="muted">Pode liberar em {sourceRoot.slice(0, 2)} (estimativa)</span>
                <strong className="num">{formatBytes(selected.reduce((sum, file) => sum + file.sizeOnDisk, 0))}</strong>
              </div>
            </div>
            {selected.length > 0 && (
              <ul className="scroll-list" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
                {selected.map((file) => (
                  <li key={file.path} className="row" style={{ padding: '7px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'nowrap' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span className="truncate" title={file.name}>
                        {file.name}
                      </span>
                      <PathText path={file.folder} />
                    </div>
                    <span className="num subtle">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      className="btn small ghost"
                      aria-label={`Remover ${file.name} da lista`}
                      onClick={() => removeFromTransfer([file.path])}
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="btn primary"
              style={{ width: '100%', marginTop: 14 }}
              disabled={selected.length === 0 || !destination || busy}
              onClick={() => void review()}
            >
              <ArrowRightLeft size={16} aria-hidden /> Revisar transferência
            </button>
            {destinationVolume && selectedSize > destinationVolume.freeBytes && (
              <div style={{ marginTop: 10 }}>
                <Notice kind="warn">O destino não tem espaço livre suficiente para todos os arquivos selecionados.</Notice>
              </div>
            )}
          </section>
        </div>
      </div>

      <Dialog
        open={preview !== null}
        wide
        busy={busy}
        title="Revisar transferência"
        description={preview ? `Destino: ${preview.destination}` : undefined}
        onClose={() => setPreview(null)}
        footer={
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!preview?.canProceed || busy || (preview.syncedCount > 0 && !acknowledgeSynced)}
              onClick={() => preview && void start(preview)}
            >
              {preview
                ? `Copiar ${plural(conflictPolicy === 'skip' ? preview.eligibleCount - preview.conflicts : preview.eligibleCount, 'arquivo', 'arquivos')}`
                : 'Copiar'}
            </button>
          </>
        }
      >
        {preview && (
          <>
            {preview.errors.map((error) => (
              <Notice key={error} kind="danger">
                {error}
              </Notice>
            ))}
            <div className="summary-list">
              <div>
                <span className="muted">Arquivos que serão copiados</span>
                <strong className="num">
                  {plural(preview.eligibleCount, 'arquivo', 'arquivos')} · {formatBytes(preview.totalSize)}
                </strong>
              </div>
              <div>
                <span className="muted">Espaço necessário no destino (com margem de segurança)</span>
                <strong className="num">{formatBytes(preview.requiredWithMargin)}</strong>
              </div>
              <div>
                <span className="muted">Livre no destino</span>
                <strong className="num">{preview.destinationVolume ? formatBytes(preview.destinationVolume.freeBytes) : '—'}</strong>
              </div>
            </div>
            <Notice kind="info">
              Os originais continuam onde estão. Depois da cópia e da verificação, você decide se quer apagá-los para liberar espaço.
            </Notice>
            {preview.conflicts > 0 && (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
                <legend className="field-label" style={{ marginBottom: 8 }}>
                  {plural(preview.conflicts, 'arquivo já existe', 'arquivos já existem')} no destino com o mesmo nome
                </legend>
                <label className="radio-card">
                  <input type="radio" name="conflict" checked={conflictPolicy === 'rename'} onChange={() => setConflictPolicy('rename')} />
                  <span>
                    <span className="title">Copiar com outro nome</span>
                    <span className="desc" style={{ display: 'block' }}>
                      Ex.: “foto (2).jpg”. Nada é sobrescrito.
                    </span>
                  </span>
                </label>
                <label className="radio-card">
                  <input type="radio" name="conflict" checked={conflictPolicy === 'skip'} onChange={() => setConflictPolicy('skip')} />
                  <span>
                    <span className="title">Pular esses arquivos</span>
                    <span className="desc" style={{ display: 'block' }}>
                      Eles continuam só no disco de origem.
                    </span>
                  </span>
                </label>
              </fieldset>
            )}
            {preview.syncedCount > 0 && (
              <Notice kind="warn">
                <strong>{plural(preview.syncedCount, 'arquivo está', 'arquivos estão')} em uma pasta sincronizada (OneDrive, Dropbox…).</strong>{' '}
                Se você apagar os originais depois, eles também podem sumir da nuvem e dos seus outros dispositivos.
                <div style={{ marginTop: 8 }}>
                  <Checkbox checked={acknowledgeSynced} onChange={setAcknowledgeSynced} label="Entendi e quero continuar" />
                </div>
              </Notice>
            )}
            <div className="scroll-list" style={{ maxHeight: 300 }}>
              <table className="table">
                <caption className="visually-hidden">Arquivos da transferência</caption>
                <thead>
                  <tr>
                    <th>Arquivo</th>
                    <th>Situação</th>
                    <th className="right">Tamanho</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((item) => (
                    <tr key={item.source}>
                      <td className="name-cell" style={{ maxWidth: 520 }}>
                        <PathText path={item.source} className="truncate" />
                        {item.eligible && <PathText path={`→ ${item.destination}`} />}
                        {item.warnings.map((warning) => (
                          <span key={warning} className="subtle" style={{ display: 'block', color: 'var(--warn)' }}>
                            {warning}
                          </span>
                        ))}
                      </td>
                      <td>
                        {!item.eligible ? (
                          <span className="badge danger" title={item.blockedReason}>
                            Não será movido
                          </span>
                        ) : item.conflict ? (
                          <span className="badge warn">Nome repetido</span>
                        ) : (
                          <span className="badge ok">Pronto</span>
                        )}
                        {!item.eligible && <span className="subtle" style={{ display: 'block' }}>{item.blockedReason}</span>}
                      </td>
                      <td className="right">{item.eligible ? formatBytes(item.size) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: copy in progress

function TransferRunning({ operationId }: { operationId: string }) {
  const progress = useApp((state) => state.transferProgress);
  const record = useApp((state) => state.transferRecord);
  const [cancelling, setCancelling] = useState(false);
  const ratio = progress && progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : 0;
  const count = progress?.fileCount ?? record?.items.length ?? 0;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Copiando arquivos</h1>
          <p>Cada arquivo é copiado e depois conferido byte a byte. Os originais não são alterados.</p>
        </div>
      </header>
      <section className="card progress-panel" aria-label="Progresso da cópia">
        <div className="row">
          <strong>
            {progress ? `Arquivo ${Math.min(progress.fileIndex + 1, count)} de ${count}` : 'Preparando…'}
            {progress && ` · ${progress.phase === 'verifying' ? 'verificando a cópia' : 'copiando'}`}
          </strong>
          <span className="muted">{formatPercent(ratio)}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void api.transfer.cancel(operationId);
            }}
          >
            {cancelling ? 'Cancelando…' : 'Cancelar'}
          </button>
        </div>
        <Meter value={ratio} indeterminate={!progress} label="Progresso da cópia" />
        {progress && (
          <div className="current" title={progress.currentFile}>
            {progress.currentFile}
          </div>
        )}
        <p className="subtle">Se cancelar, o arquivo em cópia é descartado no destino e os originais ficam intactos.</p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: result, optional removal of originals, undo

function TransferOutcome({ record }: { record: TransferRecord }) {
  const setOperation = useApp((state) => state.setTransferOperation);
  const receiveRecord = useApp((state) => state.receiveTransferRecord);
  const navigate = useApp((state) => state.navigate);
  const refreshVolumes = useApp((state) => state.refreshVolumes);
  const toast = useApp((state) => state.toast);
  const [dialog, setDialog] = useState<'remove' | 'undo' | null>(null);
  const [mode, setMode] = useState<DeleteMode>('trash');
  const [busy, setBusy] = useState(false);
  const [removal, setRemoval] = useState<RemoveOriginalsResult | null>(null);
  const [undo, setUndo] = useState<UndoTransferResult | null>(null);

  const copied = record.items.filter((item) => item.status === 'copied');
  const copiedSize = copied.reduce((sum, item) => sum + item.size, 0);
  const problems = record.items.filter((item) => item.status !== 'copied');
  const removable = copied.filter(
    (item) => !item.restored && !item.destinationRemoved && (item.originalStatus === 'kept' || item.originalStatus === 'remove-failed'),
  );
  const removed = copied.filter((item) => item.originalStatus === 'trashed' || item.originalStatus === 'deleted');
  const undoable = !record.undoneAt && copied.some((item) => !item.destinationRemoved);

  const closeDialog = () => {
    setDialog(null);
    setRemoval(null);
    setUndo(null);
  };

  const removeOriginals = async () => {
    setBusy(true);
    try {
      const result = await api.transfer.removeOriginals({ operationId: record.id, mode });
      setRemoval(result);
      receiveRecord(result.record);
      void refreshVolumes();
    } catch (error) {
      toast('error', errorMessage(error));
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  const runUndo = async () => {
    setBusy(true);
    try {
      const result = await api.transfer.undo(record.id);
      setUndo(result);
      receiveRecord(result.record);
      void refreshVolumes();
    } catch (error) {
      toast('error', errorMessage(error));
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  const labelFor = (item: TransferRecord['items'][number]) =>
    item.error ??
    (item.status === 'skipped-conflict' ? 'Pulado: já existe um arquivo com esse nome no destino.' : 'Não copiado.');

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Resultado da transferência</h1>
          <p>
            {formatDateTime(record.finishedAt ?? record.createdAt)} · destino {record.destinationRoot}
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={() => void api.shell.openFolder(record.destinationRoot).catch((e) => toast('error', errorMessage(e)))}>
            Abrir destino
          </button>
          <button type="button" className="btn primary" onClick={() => setOperation(null)}>
            Nova transferência
          </button>
        </div>
      </header>

      <div className="stack">
        <section className="card">
          <OperationResult
            status={record.status === 'running' ? 'failed' : record.status}
            headline={`${plural(copied.length, 'arquivo copiado e verificado', 'arquivos copiados e verificados')}`}
            lines={[
              { label: 'Tamanho copiado', value: formatBytes(copiedSize) },
              { label: 'Não copiados', value: String(problems.length) },
              {
                label: 'Originais',
                value: record.undoneAt
                  ? 'Transferência desfeita'
                  : removed.length
                    ? `${plural(removed.length, 'apagado', 'apagados')} (${record.removal?.mode === 'permanent' ? 'permanentemente' : 'na Lixeira'})`
                    : 'Mantidos no lugar',
              },
            ]}
            failed={problems.map((item) => ({ path: item.source, reason: labelFor(item) }))}
          />
        </section>

        {removable.length > 0 && !record.undoneAt && (
          <section className="card" aria-labelledby="step-remove">
            <div className="card-header" style={{ marginBottom: 8 }}>
              <div>
                <h2 id="step-remove">Etapa opcional: apagar os originais para liberar espaço</h2>
                <p>
                  {plural(removable.length, 'original', 'originais')} ({formatBytes(removable.reduce((sum, item) => sum + item.size, 0))}) já
                  {removable.length === 1 ? ' tem cópia verificada' : ' têm cópia verificada'} no destino.
                </p>
              </div>
              <button type="button" className="btn danger-outline" onClick={() => setDialog('remove')}>
                Apagar originais…
              </button>
            </div>
            <p className="subtle">Antes de apagar, o LimpaC confere de novo se o original não mudou e se a cópia continua no destino.</p>
          </section>
        )}

        {record.removal && removed.length > 0 && record.removal.mode === 'trash' && !record.undoneAt && (
          <Notice kind="info">
            Os originais estão na Lixeira e ainda ocupam espaço. Esvazie a Lixeira para liberar o espaço de vez.{' '}
            <button type="button" className="btn link" onClick={() => navigate('cleanup')}>
              Ir para Limpeza
            </button>
          </Notice>
        )}

        {undoable && (
          <section className="card" aria-labelledby="step-undo">
            <div className="card-header" style={{ marginBottom: 0 }}>
              <div>
                <h2 id="step-undo">Desfazer</h2>
                <p>
                  {removed.length
                    ? 'Copia os arquivos de volta para o local original e remove as cópias do destino.'
                    : 'Remove as cópias do destino. Os originais não são tocados.'}
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setDialog('undo')}>
                Desfazer transferência…
              </button>
            </div>
          </section>
        )}
      </div>

      <Dialog
        open={dialog === 'remove'}
        busy={busy}
        title={removal ? 'Originais apagados' : 'Apagar os originais?'}
        description={removal ? undefined : `${plural(removable.length, 'arquivo', 'arquivos')} em ${record.items[0]?.source.slice(0, 2) ?? ''} com cópia verificada em ${record.destinationRoot}.`}
        onClose={closeDialog}
        footer={
          removal ? (
            <button type="button" className="btn primary" onClick={closeDialog}>
              Fechar
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={closeDialog}>
                Cancelar
              </button>
              <button type="button" className={`btn ${mode === 'permanent' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => void removeOriginals()}>
                {busy ? 'Apagando…' : mode === 'trash' ? 'Enviar originais para a Lixeira' : 'Excluir originais permanentemente'}
              </button>
            </>
          )
        }
      >
        {removal ? (
          <OperationResult
            status={removal.removedCount === 0 ? 'failed' : removal.failed.length ? 'partial' : 'completed'}
            headline={`${plural(removal.removedCount, 'original apagado', 'originais apagados')}`}
            lines={[
              { label: 'Tamanho', value: formatBytes(removal.removedSize) },
              { label: 'Espaço livre ganho (medido)', value: removal.freedBytes === null ? 'Não medido' : formatBytes(removal.freedBytes) },
            ]}
            failed={removal.failed}
          >
            {mode === 'trash' && removal.removedCount > 0 && (
              <Notice kind="info">Na Lixeira, os arquivos ainda ocupam espaço até ela ser esvaziada.</Notice>
            )}
            {removal.failed.length > 0 && mode === 'trash' && (
              <Notice kind="neutral">
                Arquivos grandes demais para a Lixeira não são apagados. Se quiser, tente de novo escolhendo “Excluir permanentemente”:
                a cópia verificada continua no destino.
              </Notice>
            )}
          </OperationResult>
        ) : (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend className="visually-hidden">Como apagar</legend>
            <label className="radio-card">
              <input type="radio" name="remove-mode" checked={mode === 'trash'} onChange={() => setMode('trash')} />
              <span>
                <span className="title">Enviar para a Lixeira (recomendado)</span>
                <span className="desc" style={{ display: 'block' }}>
                  Dá para recuperar. O espaço só é liberado quando a Lixeira for esvaziada. Arquivos muito grandes podem não caber na
                  Lixeira; nesse caso eles são mantidos.
                </span>
              </span>
            </label>
            <label className="radio-card">
              <input type="radio" name="remove-mode" checked={mode === 'permanent'} onChange={() => setMode('permanent')} />
              <span>
                <span className="title">Excluir permanentemente</span>
                <span className="desc" style={{ display: 'block' }}>
                  Libera o espaço na hora. A cópia verificada continua no destino e “Desfazer” ainda consegue trazer os arquivos de volta.
                </span>
              </span>
            </label>
          </fieldset>
        )}
      </Dialog>

      <Dialog
        open={dialog === 'undo'}
        busy={busy}
        title={undo ? 'Transferência desfeita' : 'Desfazer a transferência?'}
        onClose={closeDialog}
        footer={
          undo ? (
            <button type="button" className="btn primary" onClick={closeDialog}>
              Fechar
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={closeDialog}>
                Cancelar
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void runUndo()}>
                {busy ? 'Desfazendo…' : 'Desfazer'}
              </button>
            </>
          )
        }
      >
        {undo ? (
          <OperationResult
            status={undo.failed.length === 0 ? 'completed' : undo.removedCopies > 0 ? 'partial' : 'failed'}
            headline="Resultado"
            lines={[
              { label: 'Devolvidos ao local original', value: String(undo.restoredCount) },
              { label: 'Cópias removidas do destino', value: String(undo.removedCopies) },
            ]}
            failed={undo.failed}
          />
        ) : (
          <>
            <p className="muted">
              {removed.length
                ? `${plural(removed.length, 'arquivo será copiado', 'arquivos serão copiados')} de volta para o local original (a cópia é conferida) e as cópias do destino irão para a Lixeira.`
                : 'As cópias no destino irão para a Lixeira. Os originais continuam onde estão.'}
            </p>
            <Notice kind="neutral">
              Por segurança, arquivos alterados no destino ou no local original depois da transferência não são mexidos.
            </Notice>
          </>
        )}
      </Dialog>
    </div>
  );
}

export function Transfer() {
  const operationId = useApp((state) => state.transferOperationId);
  const record = useApp((state) => state.transferRecord);
  const progress = useApp((state) => state.transferProgress);
  const setOperation = useApp((state) => state.setTransferOperation);
  const receiveRecord = useApp((state) => state.receiveTransferRecord);
  const toast = useApp((state) => state.toast);

  useEffect(() => {
    if (!operationId || record?.id === operationId) return;
    api.transfer
      .get(operationId)
      .then((value) => {
        if (value) receiveRecord(value);
        else {
          toast('error', 'Transferência não encontrada.');
          setOperation(null);
        }
      })
      .catch((error) => toast('error', errorMessage(error)));
  }, [operationId, record?.id, receiveRecord, setOperation, toast]);

  if (operationId && (progress?.operationId === operationId || (record?.id === operationId && record.status === 'running'))) {
    return <TransferRunning operationId={operationId} />;
  }
  if (operationId && record?.id === operationId) return <TransferOutcome record={record} />;
  if (operationId) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }
  return <TransferSetup />;
}
