import { HardDrive } from 'lucide-react';
import { formatBytes } from '@shared/format';
import type { VolumeInfo } from '@shared/types';
import { api, errorMessage } from '../api';
import { useApp } from '../store';
import { volumeName } from './VolumeUsageCard';
import { Checkbox, Notice } from './ui';

export function suggestedFolder(volume: VolumeInfo, sourceLetter: string): string {
  return `${volume.root}Arquivos movidos do ${sourceLetter}`;
}

export function TransferDestinationPicker({
  volumes,
  sourceLetter,
  destination,
  onDestination,
  preserveStructure,
  onPreserveStructure,
}: {
  volumes: VolumeInfo[];
  sourceLetter: string;
  destination: string | null;
  onDestination(path: string): void;
  preserveStructure: boolean;
  onPreserveStructure(value: boolean): void;
}) {
  const toast = useApp((state) => state.toast);
  const currentRoot = destination ? destination.slice(0, 3).toUpperCase() : null;

  const choose = async () => {
    try {
      const picked = await api.transfer.pickDestination(destination);
      if (picked) onDestination(picked);
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      {volumes.length === 0 ? (
        <Notice kind="warn">
          Nenhum outro disco encontrado. Conecte um HD externo ou pendrive, ou use um segundo disco interno (por exemplo, D:).
        </Notice>
      ) : (
        <fieldset style={{ border: 0, margin: 0, padding: 0 }} className="stack">
          <legend className="field-label" style={{ marginBottom: 8 }}>
            Disco de destino
          </legend>
          {volumes.map((volume) => (
            <label key={volume.root} className="radio-card">
              <input
                type="radio"
                name="destination-volume"
                checked={currentRoot === volume.root}
                onChange={() => onDestination(suggestedFolder(volume, sourceLetter))}
              />
              <HardDrive size={16} aria-hidden style={{ marginTop: 2, color: 'var(--text-3)' }} />
              <span style={{ flex: 1 }}>
                <span className="title">{volumeName(volume)}</span>
                <span className="desc" style={{ display: 'block' }}>
                  {formatBytes(volume.freeBytes)} livres de {formatBytes(volume.totalBytes)}
                  {volume.fileSystem === 'FAT32' && ' · FAT32: arquivos de até 4 GB'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="field">
        <span className="field-label">Pasta de destino</span>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            className="input"
            style={{ flex: 1 }}
            readOnly
            value={destination ?? ''}
            placeholder="Escolha um disco ou uma pasta"
            aria-label="Pasta de destino"
            title={destination ?? undefined}
          />
          <button type="button" className="btn" onClick={() => void choose()}>
            Escolher pasta…
          </button>
        </div>
        <span className="hint">A pasta é criada se ainda não existir. Nada é sobrescrito.</span>
      </div>
      <Checkbox
        checked={preserveStructure}
        onChange={onPreserveStructure}
        label="Manter a organização das pastas (ex.: Vídeos\Viagem\arquivo.mp4)"
      />
    </div>
  );
}
