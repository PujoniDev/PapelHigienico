import { AppWindow, ArrowRightLeft, FolderSearch, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { formatBytes, formatDateTime } from '@shared/format';
import type { HistoryEntry, HistoryType } from '@shared/types';
import { StatusBadge } from './ui';

const ICONS: Record<HistoryType, typeof Sparkles> = {
  scan: FolderSearch,
  cleanup: Sparkles,
  'recycle-bin': Trash2,
  transfer: ArrowRightLeft,
  'transfer-remove': Trash2,
  'transfer-undo': RotateCcw,
  uninstall: AppWindow,
};

export function ActivityList({
  entries,
  onReport,
  onOpenTransfer,
}: {
  entries: HistoryEntry[];
  onReport(entry: HistoryEntry): void;
  onOpenTransfer(transferId: string): void;
}) {
  return (
    <ol className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {entries.map((entry) => {
        const Icon = ICONS[entry.type];
        return (
          <li key={entry.id} className="activity">
            <span className="icon" aria-hidden>
              <Icon size={17} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <h3>{entry.title}</h3>
                <StatusBadge status={entry.status} />
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                {entry.summary}
              </p>
              <p className="subtle">
                {formatDateTime(entry.finishedAt)}
                {entry.estimatedBytes !== null && ` · estimado ${formatBytes(entry.estimatedBytes)}`}
                {entry.freedBytes !== null && ` · espaço liberado (medido) ${formatBytes(entry.freedBytes)}`}
              </p>
            </div>
            <div className="row end" style={{ gap: 6 }}>
              {entry.transferId && entry.type === 'transfer' && (
                <button type="button" className="btn small" onClick={() => onOpenTransfer(entry.transferId!)}>
                  Abrir transferência
                </button>
              )}
              {entry.hasReport && (
                <button type="button" className="btn small" onClick={() => onReport(entry)}>
                  Ver relatório
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
