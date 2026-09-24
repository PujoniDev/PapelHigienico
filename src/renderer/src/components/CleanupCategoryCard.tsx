import { useEffect, useState } from 'react';
import { formatBytes, formatDate, formatCount, plural } from '@shared/format';
import type { CleanupCategory, CleanupItem } from '@shared/types';
import { api, errorMessage } from '../api';
import { RiskBadge } from './RiskBadge';
import { Checkbox, Loading, Notice, PathText } from './ui';

/** 'all' = every item except the listed ones; 'only' = exactly the listed ones. Values are sizes. */
export interface CategorySelection {
  mode: 'all' | 'only';
  paths: Record<string, number>;
}

export function selectionCount(category: CleanupCategory, selection: CategorySelection | undefined) {
  if (!selection) return { count: 0, size: 0 };
  const listedCount = Object.keys(selection.paths).length;
  const listedSize = Object.values(selection.paths).reduce((sum, size) => sum + size, 0);
  return selection.mode === 'all'
    ? { count: category.itemCount - listedCount, size: category.size - listedSize }
    : { count: listedCount, size: listedSize };
}

const PAGE = 100;

export function CleanupCategoryCard({
  category,
  selection,
  onChange,
}: {
  category: CleanupCategory;
  selection: CategorySelection | undefined;
  onChange(selection: CategorySelection | undefined): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<CleanupItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
  }, [category]);

  useEffect(() => {
    if (!expanded || items) return;
    api.cleanup
      .items({ categoryId: category.id, offset: 0, limit: PAGE })
      .then((page) => {
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [expanded, items, category.id]);

  const loadMore = async () => {
    if (!items) return;
    const page = await api.cleanup.items({ categoryId: category.id, offset: items.length, limit: PAGE });
    setItems([...items, ...page.items]);
  };

  const { count, size } = selectionCount(category, selection);
  const reviewOnly = category.kind === 'review';
  const empty = category.itemCount === 0;
  const isSelected = (path: string) => (selection?.mode === 'all' ? !(path in selection.paths) : Boolean(selection && path in selection.paths));

  const toggleItem = (item: CleanupItem, checked: boolean) => {
    const current = selection ?? { mode: 'only' as const, paths: {} };
    const paths = { ...current.paths };
    const listed = current.mode === 'all' ? !checked : checked;
    if (listed) paths[item.path] = item.size;
    else delete paths[item.path];
    const next = { mode: current.mode, paths };
    const nothing = next.mode === 'only' ? Object.keys(paths).length === 0 : Object.keys(paths).length >= category.itemCount;
    onChange(nothing ? undefined : next);
  };

  const headingId = `cleanup-${category.id}`;
  return (
    <section className="card cleanup-card" aria-labelledby={headingId}>
      <div className="head">
        <div style={{ paddingTop: 2 }}>
          {reviewOnly ? (
            <span style={{ display: 'inline-block', width: 16 }} />
          ) : (
            <Checkbox
              checked={count > 0 && count === category.itemCount}
              indeterminate={count > 0 && count < category.itemCount}
              disabled={empty}
              onChange={(checked) => onChange(checked ? { mode: 'all', paths: {} } : undefined)}
              label={`Selecionar todos: ${category.title}`}
              hideLabel
            />
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <h3 id={headingId}>{category.title}</h3>
          <p className="muted" style={{ marginTop: 2 }}>
            {category.description}
          </p>
          <div className="meta">
            <RiskBadge risk={category.risk} />
            <span className="subtle">{category.riskReason}</span>
          </div>
          {category.notes.length > 0 && (
            <ul className="subtle" style={{ margin: '8px 0 0', paddingLeft: 16 }}>
              {category.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {category.error && (
            <div style={{ marginTop: 8 }}>
              <Notice kind="warn">{category.error}</Notice>
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="size">{formatBytes(category.size)}</div>
          <div className="subtle">{plural(category.itemCount, 'arquivo', 'arquivos')}</div>
          {count > 0 && (
            <div className="subtle" style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {formatCount(count)} selecionados · {formatBytes(size)}
            </div>
          )}
          <button
            type="button"
            className="btn small"
            style={{ marginTop: 8 }}
            aria-expanded={expanded}
            disabled={empty}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Ocultar arquivos' : 'Ver arquivos'}
          </button>
        </div>
      </div>

      {category.sources.some((source) => source.blockedReason || category.sources.length > 1) && (
        <div className="sources">
          {category.sources.map((source) => (
            <div key={source.id}>
              <span>{source.label}</span>
              <span className="num">
                {source.blockedReason ? <span style={{ color: 'var(--warn)' }}>{source.blockedReason}</span> : formatBytes(source.size)}
              </span>
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="body">
          {error ? (
            <div style={{ padding: 16 }}>
              <Notice kind="danger">{error}</Notice>
            </div>
          ) : !items ? (
            <Loading />
          ) : (
            <>
              <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
                <table className="table">
                  <caption className="visually-hidden">Arquivos de {category.title}</caption>
                  <thead>
                    <tr>
                      <th className="check">
                        <span className="visually-hidden">Selecionar</span>
                      </th>
                      <th>Arquivo</th>
                      <th>Origem</th>
                      <th>Modificado</th>
                      <th className="right">Tamanho</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.path} aria-selected={isSelected(item.path)}>
                        <td className="check">
                          <Checkbox
                            checked={isSelected(item.path)}
                            onChange={(checked) => toggleItem(item, checked)}
                            label={`Selecionar ${item.name}`}
                            hideLabel
                          />
                        </td>
                        <td className="name-cell">
                          <span className="truncate" title={item.name}>
                            {item.name} {item.tag && <span className="tag">{item.tag}</span>}
                          </span>
                          <PathText path={item.path} />
                        </td>
                        <td className="subtle">{item.sourceLabel}</td>
                        <td className="num subtle">{formatDate(item.modifiedMs)}</td>
                        <td className="right">{formatBytes(item.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-footer">
                <span>
                  Mostrando {formatCount(items.length)} de {formatCount(total)}, do maior para o menor
                </span>
                {items.length < total && (
                  <button type="button" className="btn small" onClick={() => void loadMore()}>
                    Mostrar mais
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
