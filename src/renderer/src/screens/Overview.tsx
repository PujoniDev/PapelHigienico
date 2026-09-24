import { useEffect, useState } from 'react';
import { ArrowRightLeft, FileSearch, FolderOpen, HardDrive, Sparkles } from 'lucide-react';
import { formatBytes, formatDateTime, plural } from '@shared/format';
import type { Opportunities } from '@shared/types';
import { api, errorMessage } from '../api';
import { freeTone, volumeName, VolumeUsageCard } from '../components/VolumeUsageCard';
import { EmptyState, Meter, Notice, Spinner, StatusBadge } from '../components/ui';
import { currentSummary, useApp } from '../store';

export function Overview() {
  const volumes = useApp((state) => state.volumes);
  const settings = useApp((state) => state.settings);
  const scan = useApp((state) => state.scan);
  const navigate = useApp((state) => state.navigate);
  const openAnalyze = useApp((state) => state.openAnalyze);
  const startScan = useApp((state) => state.startScan);
  const categories = useApp((state) => state.cleanupCategories);
  const setCategories = useApp((state) => state.setCleanupCategories);
  const toast = useApp((state) => state.toast);
  const [opportunities, setOpportunities] = useState<Opportunities | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const volume =
    volumes.find((candidate) => candidate.root === settings?.defaultVolume) ?? volumes.find((candidate) => candidate.isSystem) ?? volumes[0];
  const summary = currentSummary(scan);
  const loadedScanId = scan.status === 'ready' ? scan.summary.scanId : null;
  const detailsAvailable = scan.status === 'ready' && summary?.scanId === loadedScanId;

  useEffect(() => {
    api.scan
      .opportunities()
      .then(setOpportunities)
      .catch((error) => toast('error', errorMessage(error)));
  }, [loadedScanId, settings?.largeFileThresholdMB, toast]);

  useEffect(() => {
    if (categories) return;
    api.cleanup
      .categories(false)
      .then(setCategories)
      .catch((error) => setCleanupError(errorMessage(error)));
  }, [categories, setCategories]);

  const cleanupEstimate = categories
    ?.filter((category) => category.kind === 'files')
    .reduce((total, category) => ({ size: total.size + category.size, count: total.count + category.itemCount }), { size: 0, count: 0 });

  const scanning = scan.status === 'running';
  const scanRoot = volume?.root ?? 'C:\\';
  const onAnalyze = () => {
    if (scanning) return navigate('analyze');
    void startScan({ root: scanRoot, includeHidden: false, includeUserFolders: true });
    navigate('analyze');
  };

  const otherVolumes = volumes.filter((candidate) => candidate.root !== volume?.root);
  const largest = summary?.topFolders ?? [];
  const largestTotal = summary?.totalSize || 1;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Visão geral</h1>
          <p>Quanto espaço resta e por onde começar. Nada é alterado sem a sua confirmação.</p>
        </div>
        <button type="button" className="btn primary large" onClick={onAnalyze}>
          {scanning ? 'Ver análise em andamento' : `Analisar ${scanRoot.slice(0, 2)}`}
        </button>
      </header>

      <div className="stack">
        <div className="overview-grid">
          <div className="stack">
            {volume ? (
              <VolumeUsageCard volume={volume} />
            ) : (
              <div className="card">
                <EmptyState icon={<HardDrive size={28} />} title="Nenhum disco encontrado" />
              </div>
            )}
            <div className="card">
              <div className="row">
                <div>
                  <div className="stat-label">Última análise</div>
                  <div>
                    {summary ? (
                      <span className="row" style={{ gap: 8 }}>
                        {formatDateTime(summary.finishedAt)} · {summary.root}
                        <StatusBadge status={summary.status} />
                      </span>
                    ) : (
                      'Nunca analisado'
                    )}
                  </div>
                </div>
                <span className="spacer" />
                {scanning && (
                  <span className="row muted">
                    <Spinner label="Análise em andamento" /> Analisando…
                  </span>
                )}
              </div>
              {summary && summary.status !== 'failed' && (
                <p className="subtle" style={{ marginTop: 8 }}>
                  {formatBytes(summary.totalSize)} em {plural(summary.fileCount, 'arquivo', 'arquivos')}
                  {summary.inaccessibleCount > 0 && ` · ${plural(summary.inaccessibleCount, 'pasta sem acesso', 'pastas sem acesso')}`}
                </p>
              )}
            </div>
          </div>

          <section className="card flush" aria-labelledby="opp-title">
            <div className="card-header">
              <div>
                <h2 id="opp-title">Oportunidades encontradas</h2>
                <p>Estimativas. Os valores podem se sobrepor e nada foi alterado.</p>
              </div>
            </div>
            <div className="list" style={{ marginTop: 6 }}>
              <div className="opportunity">
                <span className="icon" aria-hidden>
                  <Sparkles size={18} />
                </span>
                <div>
                  <strong>Temporários e caches conhecidos</strong>
                  <div className="subtle">Temporários antigos, relatórios de erro e caches que os aplicativos recriam.</div>
                </div>
                <div className="side">
                  <span className="value">
                    {cleanupError ? '—' : cleanupEstimate ? formatBytes(cleanupEstimate.size) : <Spinner label="Calculando" />}
                  </span>
                  <button type="button" className="btn small" onClick={() => navigate('cleanup')}>
                    Revisar
                  </button>
                </div>
              </div>
              <div className="opportunity">
                <span className="icon" aria-hidden>
                  <FileSearch size={18} />
                </span>
                <div>
                  <strong>Arquivos grandes para revisar</strong>
                  <div className="subtle">
                    {opportunities?.largeFiles
                      ? `${plural(opportunities.largeFiles.count, 'arquivo', 'arquivos')} com mais de ${formatBytes(opportunities.largeFiles.threshold)}, fora das pastas do sistema.`
                      : 'Analise o disco para encontrar os maiores arquivos.'}
                  </div>
                </div>
                <div className="side">
                  <span className="value">{opportunities?.largeFiles ? formatBytes(opportunities.largeFiles.size) : '—'}</span>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!detailsAvailable}
                    onClick={() =>
                      openAnalyze({ tab: 'files', minSize: (settings?.largeFileThresholdMB ?? 500) * 1024 * 1024, category: null, underFolderId: null })
                    }
                  >
                    Ver arquivos
                  </button>
                </div>
              </div>
              <div className="opportunity">
                <span className="icon" aria-hidden>
                  <ArrowRightLeft size={18} />
                </span>
                <div>
                  <strong>Arquivos pessoais que podem ser movidos</strong>
                  <div className="subtle">
                    {!opportunities?.movable
                      ? 'Analise o disco para ver vídeos, fotos e documentos grandes que podem ir para outro disco.'
                      : opportunities.movable.hasOtherVolume
                        ? `${plural(opportunities.movable.count, 'arquivo', 'arquivos')} com mais de ${formatBytes(opportunities.movable.minSize)} nas suas pastas pessoais.`
                        : 'Conecte outro disco (HD externo ou D:) para mover arquivos.'}
                  </div>
                </div>
                <div className="side">
                  <span className="value">{opportunities?.movable ? formatBytes(opportunities.movable.size) : '—'}</span>
                  <button type="button" className="btn small" onClick={() => navigate('transfer')}>
                    Mover arquivos
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <section className="card flush" aria-labelledby="largest-title">
          <div className="card-header">
            <div>
              <h2 id="largest-title">Maiores pastas {summary ? `em ${summary.root}` : ''}</h2>
              <p>
                {detailsAvailable
                  ? 'As pastas que mais ocupam espaço na última análise.'
                  : summary
                    ? 'Resultado salvo da última análise. Analise novamente para navegar pelos detalhes.'
                    : 'Analise o disco para ver onde o espaço está sendo usado.'}
              </p>
            </div>
          </div>
          {largest.length === 0 ? (
            <EmptyState icon={<FolderOpen size={28} />} title="Nenhuma análise ainda">
              <button type="button" className="btn primary" onClick={onAnalyze}>
                Analisar {scanRoot.slice(0, 2)}
              </button>
            </EmptyState>
          ) : (
            <div className="list" style={{ marginTop: 6 }}>
              {largest.map((folder) => (
                <div key={folder.id} className="bar-row" style={{ gridTemplateColumns: 'minmax(140px, 240px) minmax(0, 1fr) 90px auto' }}>
                  <span className="cell-name">
                    <FolderOpen size={16} className="folder-icon" aria-hidden />
                    <span className="truncate" title={folder.path}>
                      {folder.name}
                    </span>
                  </span>
                  <Meter thin value={folder.size / largestTotal} label={`${folder.name}: ${formatBytes(folder.size)}`} />
                  <span className="num" style={{ textAlign: 'right' }}>
                    {formatBytes(folder.size)}
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!detailsAvailable}
                    onClick={() => openAnalyze({ tab: 'folders', folderId: folder.id })}
                  >
                    Ver detalhes
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {otherVolumes.length > 0 && (
          <section className="card flush" aria-labelledby="other-volumes">
            <div className="card-header">
              <div>
                <h2 id="other-volumes">Outros discos</h2>
                <p>Destinos possíveis para mover arquivos pessoais.</p>
              </div>
            </div>
            <div className="list" style={{ marginTop: 6 }}>
              {otherVolumes.map((other) => (
                <div key={other.root} className="bar-row" style={{ gridTemplateColumns: 'minmax(140px, 240px) minmax(0, 1fr) 150px' }}>
                  <span className="cell-name">
                    <HardDrive size={16} aria-hidden />
                    <span className="truncate">{volumeName(other)}</span>
                  </span>
                  <Meter
                    thin
                    tone={freeTone(other)}
                    value={other.totalBytes ? other.usedBytes / other.totalBytes : 0}
                    label={`Espaço usado em ${other.letter}:`}
                  />
                  <span className="num subtle" style={{ textAlign: 'right' }}>
                    {formatBytes(other.freeBytes)} livres de {formatBytes(other.totalBytes)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {volume && freeTone(volume) && (
          <Notice kind={freeTone(volume) === 'danger' ? 'danger' : 'warn'}>
            <strong>Pouco espaço livre em {volume.letter}:.</strong> O Windows precisa de espaço livre para atualizações e arquivos
            temporários. Comece pela limpeza de temporários ou mova arquivos pessoais grandes para outro disco.
          </Notice>
        )}
      </div>
    </div>
  );
}
