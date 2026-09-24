import type { RiskLevel } from '@shared/types';

const LABELS: Record<RiskLevel, { text: string; tone: string }> = {
  low: { text: 'Risco baixo', tone: 'ok' },
  medium: { text: 'Atenção', tone: 'warn' },
  review: { text: 'Revisar um a um', tone: 'warn' },
  high: { text: 'Irreversível', tone: 'danger' },
};

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const { text, tone } = LABELS[risk];
  return <span className={`badge ${tone}`}>{text}</span>;
}
