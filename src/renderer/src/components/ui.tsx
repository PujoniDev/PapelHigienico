import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import { useApp } from '../store';

export function Notice({
  kind = 'info',
  children,
  icon = true,
}: {
  kind?: 'info' | 'warn' | 'danger' | 'ok' | 'neutral';
  children: ReactNode;
  icon?: boolean;
}) {
  const Icon = kind === 'warn' ? AlertTriangle : kind === 'danger' ? OctagonAlert : kind === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={`notice ${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      {icon && <Icon size={16} aria-hidden />}
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Meter({
  value,
  label,
  tone,
  thin,
  indeterminate,
}: {
  value: number;
  label: string;
  tone?: 'warn' | 'danger';
  thin?: boolean;
  indeterminate?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={['meter', tone, thin ? 'thin' : '', indeterminate ? 'indeterminate' : ''].filter(Boolean).join(' ')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ label = 'Carregando' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Loading({ text = 'Carregando…' }: { text?: string }) {
  return (
    <div className="row muted" style={{ padding: 20 }}>
      <Spinner label={text} /> {text}
    </div>
  );
}

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  hideLabel = false,
  disabled = false,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange(checked: boolean): void;
  label: ReactNode;
  hideLabel?: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className={`checkbox${disabled ? ' disabled' : ''}`}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {hideLabel ? <span className="visually-hidden">{label}</span> : <span>{label}</span>}
    </label>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          className="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

/** Truncated path with the full value in a tooltip. */
export function PathText({ path, className = 'path' }: { path: string; className?: string }) {
  return (
    <span className={className} title={path}>
      {path}
    </span>
  );
}

export function CopyPathButton({ path }: { path: string }) {
  const toast = useApp((state) => state.toast);
  return (
    <button
      type="button"
      className="btn small"
      onClick={() =>
        navigator.clipboard
          .writeText(path)
          .then(() => toast('success', 'Caminho copiado.'))
          .catch(() => toast('error', 'Não foi possível copiar o caminho.'))
      }
    >
      Copiar caminho
    </button>
  );
}

/**
 * Modal dialog built on <dialog>: focus stays inside, Esc closes (unless busy)
 * and the page behind is inert.
 */
export function Dialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  wide = false,
  busy = false,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  onClose(): void;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {open && (
        <div className="dialog-inner">
          <div className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {children && <div className="dialog-body">{children}</div>}
          <div className="dialog-footer">{footer}</div>
        </div>
      )}
    </dialog>
  );
}

export function StatusBadge({ status }: { status: 'completed' | 'partial' | 'cancelled' | 'failed' | 'running' }) {
  switch (status) {
    case 'completed':
      return <span className="badge ok">Concluída</span>;
    case 'partial':
      return <span className="badge warn">Parcial</span>;
    case 'cancelled':
      return <span className="badge">Cancelada</span>;
    case 'failed':
      return <span className="badge danger">Falhou</span>;
    default:
      return <span className="badge info">Em andamento</span>;
  }
}
