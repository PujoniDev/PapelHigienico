import { useEffect, useState } from 'react';
import { CheckCircle2, History as HistoryIcon, RefreshCw, XCircle } from 'lucide-react';
import type { HistoryEntry, HistoryReport } from '@shared/types';
import { api, errorMessage } from '../api';
import { ActivityList } from '../components/ActivityList';
import { Dialog, EmptyState, Loading, Notice } from '../components/ui';
import { useApp } from '../store';

export function History() {
  const toast = useApp((state) => state.toast);
  const navigate = useApp((state) => state.navigate);
  const setTransferOperation = useApp((state) => state.setTransferOperation);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [report, setReport] = useState<HistoryReport | null>(null);

  const load = async () => {
    try {
      setEntries(await api.history.list());
    } catch (error) {
      toast('error', errorMessage(error));
      setEntries([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openReport = async (entry: HistoryEntry) => {
    try {
      const value = await api.history.report(entry.id);
      if (value) setReport(value);
      else toast('error', 'Relatório não encontrado.');
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Histórico</h1>
          <p>Registro local das análises, limpezas e transferências. Guarda caminhos e tamanhos, nunca o conteúdo dos arquivos.</p>
        </div>
        <button type="button" className="btn" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden /> Atualizar
        </button>
      </header>

      <section className="card flush" aria-label="Operações">
        {!entries ? (
          <Loading />
        ) : entries.length === 0 ? (
          <EmptyState icon={<HistoryIcon size={28} />} title="Nenhuma operação registrada">
            <p className="muted">As análises, limpezas e transferências aparecem aqui.</p>
          </EmptyState>
        ) : (
          <ActivityList
            entries={entries}
            onReport={(entry) => void openReport(entry)}
            onOpenTransfer={(id) => {
              setTransferOperation(id);
              navigate('transfer');
            }}
          />
        )}
      </section>

      <Dialog
        open={report !== null}
        wide
        title={report?.entry.title ?? ''}
        description={report?.entry.summary}
        onClose={() => setReport(null)}
        footer={
          <button type="button" className="btn primary" onClick={() => setReport(null)}>
            Fechar
          </button>
        }
      >
        {report && (
          <>
            {report.lines.length > 0 && (
              <div className="summary-list">
                {report.lines.map((line) => (
                  <div key={line.label}>
                    <span className="muted">{line.label}</span>
                    <strong className="num" style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>
                      {line.value}
                    </strong>
                  </div>
                ))}
              </div>
            )}
            {report.items.length > 0 && (
              <div className="scroll-list" style={{ maxHeight: 360 }}>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {report.items.map((item, index) => (
                    <li
                      key={`${item.path}-${index}`}
                      className="row"
                      style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'nowrap', alignItems: 'flex-start' }}
                    >
                      {item.ok ? (
                        <CheckCircle2 size={15} style={{ color: 'var(--ok)', flex: 'none', marginTop: 2 }} aria-label="Concluído" />
                      ) : (
                        <XCircle size={15} style={{ color: 'var(--danger)', flex: 'none', marginTop: 2 }} aria-label="Não concluído" />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{item.path}</div>
                        <div className="subtle" style={{ overflowWrap: 'anywhere' }}>
                          {item.detail}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.truncatedItems > 0 && <Notice kind="neutral">E mais {report.truncatedItems} itens não listados.</Notice>}
          </>
        )}
      </Dialog>
    </div>
  );
}
