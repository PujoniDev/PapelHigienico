const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'];

const numberFormats = new Map<number, Intl.NumberFormat>();
function numberFormat(digits: number): Intl.NumberFormat {
  let format = numberFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: digits });
    numberFormats.set(digits, format);
  }
  return format;
}

/** Human-readable size using binary multiples and pt-BR decimals, e.g. "1,5 GB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} ${bytes === 1 ? 'byte' : 'bytes'}`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${numberFormat(digits).format(value)} ${UNITS[unit]}`;
}

export function formatCount(value: number): string {
  return numberFormat(0).format(value);
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  const pct = ratio * 100;
  return `${numberFormat(pct < 10 ? 1 : 0).format(pct)}%`;
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return dateTime.format(new Date(ms));
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return dateOnly.format(new Date(ms));
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}
