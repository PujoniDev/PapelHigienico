import type { ReactNode } from 'react';
import { plural } from '@shared/format';
import type { FailedItem, OperationStatus } from '@shared/types';
import { Notice, StatusBadge } from './ui';

export function OperationResult({
  status,
  headline,
  lines,
  failed = [],
  skipped = [],
  children,
}: {
  status: OperationStatus;
  headline: string;
  lines: { label: string; value: ReactNode }[];
  failed?: FailedItem[];
  skipped?: FailedItem[];
  children?: ReactNode;
}) {
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <strong style={{ fontSize: 15 }}>{headline}</strong>
        <StatusBadge status={status} />
      </div>
      <div className="summary-list">
        {lines.map((line) => (
          <div key={line.label}>
            <span className="muted">{line.label}</span>
            <strong className="num">{line.value}</strong>
          </div>
        ))}
      </div>
      {children}
      {failed.length > 0 && <IssueList kind="danger" title={plural(failed.length, 'item não foi concluído', 'itens não foram concluídos')} items={failed} />}
      {skipped.length > 0 && <IssueList kind="warn" title={plural(skipped.length, 'item foi ignorado por segurança', 'itens foram ignorados por segurança')} items={skipped} />}
    </div>
  );
}

function IssueList({ kind, title, items }: { kind: 'danger' | 'warn'; title: string; items: FailedItem[] }) {
  return (
    <Notice kind={kind}>
      <details>
        <summary style={{ cursor: 'pointer' }}>
          <strong>{title}</strong> — ver detalhes
        </summary>
        <ul style={{ margin: '8px 0 0', paddingLeft: 16, maxHeight: 200, overflow: 'auto', fontSize: 12.5 }}>
          {items.slice(0, 300).map((item) => (
            <li key={item.path} style={{ overflowWrap: 'anywhere' }}>
              {item.path}
              <br />
              <span className="muted">{item.reason}</span>
            </li>
          ))}
          {items.length > 300 && <li>… e mais {items.length - 300}</li>}
        </ul>
      </details>
    </Notice>
  );
}
