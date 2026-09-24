import type { ReactNode } from 'react';
import { formatBytes, formatPercent } from '@shared/format';
import type { VolumeInfo } from '@shared/types';
import { Meter } from './ui';

export function volumeName(volume: VolumeInfo): string {
  const label = volume.label || (volume.type === 'removable' ? 'Disco removível' : volume.type === 'network' ? 'Unidade de rede' : 'Disco local');
  return `${label} (${volume.letter}:)`;
}

export function freeTone(volume: VolumeInfo): 'warn' | 'danger' | undefined {
  const freeRatio = volume.totalBytes > 0 ? volume.freeBytes / volume.totalBytes : 1;
  if (freeRatio < 0.05) return 'danger';
  if (freeRatio < 0.15) return 'warn';
  return undefined;
}

export function VolumeUsageCard({ volume, action }: { volume: VolumeInfo; action?: ReactNode }) {
  const used = volume.totalBytes > 0 ? volume.usedBytes / volume.totalBytes : 0;
  const tone = freeTone(volume);
  return (
    <section className="card volume-card stack" aria-labelledby={`vol-${volume.letter}`}>
      <div className="card-header" style={{ marginBottom: 0 }}>
        <div>
          <div className="volume-title">
            <strong id={`vol-${volume.letter}`}>{volumeName(volume)}</strong>
            {volume.isSystem && <span className="badge">Disco do Windows</span>}
          </div>
          <p className="subtle">{volume.fileSystem || 'Sistema de arquivos desconhecido'}</p>
        </div>
        {action}
      </div>
      <div>
        <div className="volume-free">{formatBytes(volume.freeBytes)} livres</div>
        <div className="muted">de {formatBytes(volume.totalBytes)} no total</div>
      </div>
      <Meter value={used} tone={tone} label={`Espaço usado em ${volume.letter}: ${formatPercent(used)}`} />
      <div className="legend">
        <span>
          <i style={{ background: tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--bar)' }} />
          Usado {formatBytes(volume.usedBytes)} ({formatPercent(used)})
        </span>
        <span>
          <i style={{ background: 'var(--track)' }} />
          Livre {formatBytes(volume.freeBytes)}
        </span>
      </div>
    </section>
  );
}
