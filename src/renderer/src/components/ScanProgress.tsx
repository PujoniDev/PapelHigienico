import { formatBytes, formatCount, formatDuration, formatPercent } from '@shared/format';
import type { ScanProgress as Progress } from '@shared/types';
import { Meter, Spinner } from './ui';

export function ScanProgress({ progress, onCancel }: { progress: Progress; onCancel(): void }) {
  const ratio = progress.estimatedRatio;
  return (
    <section className="card progress-panel" aria-label="Progresso da análise">
      <div className="row">
        <Spinner label="Analisando" />
        <strong>Analisando {progress.root}</strong>
        {ratio !== null && <span className="muted">cerca de {formatPercent(ratio)}</span>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancelar
        </button>
      </div>
      <Meter value={ratio ?? 0} indeterminate={ratio === null || ratio === 0} label="Progresso da análise" />
      <div className="stats">
        <div>
          <div className="stat-label">Arquivos lidos</div>
          <div className="stat-value small">{formatCount(progress.filesScanned)}</div>
        </div>
        <div>
          <div className="stat-label">Pastas</div>
          <div className="stat-value small">{formatCount(progress.dirsScanned)}</div>
        </div>
        <div>
          <div className="stat-label">Tamanho encontrado</div>
          <div className="stat-value small">{formatBytes(progress.bytesScanned)}</div>
        </div>
        <div>
          <div className="stat-label">Tempo</div>
          <div className="stat-value small">{formatDuration(progress.elapsedMs)}</div>
        </div>
      </div>
      <div className="current" title={progress.currentPath}>
        Lendo: {progress.currentPath}
      </div>
      <p className="subtle">
        A análise só lê informações das pastas; nada é alterado. Você pode continuar usando o computador ou cancelar a qualquer
        momento e ver os resultados parciais.
      </p>
    </section>
  );
}
