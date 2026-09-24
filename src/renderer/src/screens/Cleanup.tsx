import { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { formatBytes, plural } from '@shared/format';
import type {
  CleanupCategory,
  CleanupCategoryId,
  CleanupPreview,
  CleanupProgress,
  CleanupResult,
  CleanupSelection,
  DeleteMode,
  RecycleBinEmptyResult,
} from '@shared/types';
import { api, errorMessage } from '../api';
import { CleanupCategoryCard, selectionCount, type CategorySelection } from '../components/CleanupCategoryCard';
import { OperationResult } from '../components/OperationResult';
import { RiskBadge } from '../components/RiskBadge';
import { Dialog, Loading, Meter, Notice } from '../components/ui';
import { useApp } from '../store';

type Step =
  | { name: 'closed' }
  | { name: 'review'; preview: CleanupPreview }
  | { name: 'running'; progress: CleanupProgress | null }
  | { name: 'done'; result: CleanupResult };

function RecycleBinCard({ category, onChanged }: { category: CleanupCategory; onChanged(): void }) {
  const toast = useApp((state) => state.toast);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecycleBinEmptyResult | null>(null);

  const empty = async () => {
    setBusy(true);
    try {
      setResult(await api.recycleBin.empty());
      onChanged();
    } catch (error) {
      toast('error', errorMessage(error));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card cleanup-card" aria-labelledby="cleanup-recycle">
      <div className="head">
        <span style={{ display: 'inline-block', width: 16 }} />
        <div>
          <h3 id="cleanup-recycle">{category.title}</h3>
          <p className="muted" style={{ marginTop: 2 }}>
            {category.description}
          </p>
          <div className="meta">
            <RiskBadge risk={category.risk} />
            <span className="subtle">{category.riskReason}</span>
          </div>
          {category.error && (
            <div style={{ marginTop: 8 }}>
              <Notice kind="warn">{category.error}</Notice>
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="size">{formatBytes(category.size)}</div>
          <div className="subtle">{plural(category.itemCount, 'item', 'itens')}</div>
          <div className="row end" style={{ marginTop: 8, gap: 6 }}>
            <button type="button" className="btn small" onClick={() => void api.recycleBin.open()}>
              Abrir Lixeira
            </button>
            <button
              type="button"
              className="btn small danger-outline"
              disabled={category.itemCount === 0}
              onClick={() => {
                setResult(null);
                setConfirm(true);
              }}
            >
              Esvaziar…
            </button>
          </div>
        </div>
      </div>
      <Dialog
        open={confirm}
        busy={busy}
        title={result ? 'Lixeira' : 'Esvaziar a Lixeira?'}
        description={
          result
            ? undefined
            : `${plural(category.itemCount, 'item será apagado', 'itens serão apagados')} definitivamente (${formatBytes(category.size)}), em todos os discos.`
        }
        onClose={() => setConfirm(false)}
        footer={
          result ? (
            <button type="button" className="btn primary" onClick={() => setConfirm(false)}>
              Fechar
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>
                Cancelar
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void empty()}>
                {busy ? 'Esvaziando…' : `Apagar ${plural(category.itemCount, 'item', 'itens')} definitivamente`}
              </button>
            </>
          )
        }
      >
        {result ? (
          <Notice kind={result.ok ? 'ok' : 'danger'}>
            {result.ok ? 'A Lixeira foi esvaziada.' : 'Não foi possível esvaziar a Lixeira.'} {result.message}
            {result.freedBytes !== null && result.ok && ` Espaço liberado: ${formatBytes(result.freedBytes)}.`}
          </Notice>
        ) : (
          <Notice kind="danger">
            Esta ação não pode ser desfeita. Se tiver dúvida, abra a Lixeira e confira o conteúdo antes.
          </Notice>
        )}
      </Dialog>
    </section>
  );
}

export function Cleanup() {
  const categories = useApp((state) => state.cleanupCategories);
  const setCategories = useApp((state) => state.setCleanupCategories);
  const toast = useApp((state) => state.toast);
  const refreshVolumes = useApp((state) => state.refreshVolumes);
  const [loading, setLoading] = useState(false);
  const [selections, setSelections] = useState<Partial<Record<CleanupCategoryId, CategorySelection>>>({});
  const [mode, setMode] = useState<DeleteMode>('trash');
  const [step, setStep] = useState<Step>({ name: 'closed' });

  const load = async (refresh: boolean) => {
    setLoading(true);
    try {
      setCategories(await api.cleanup.categories(refresh));
      setSelections({});
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  // Re-scan the rule folders each time the screen opens so the list reflects the disk now.
  useEffect(() => {
    void load(true);
  }, []);

  useEffect(() => {
    if (step.name !== 'running') return;
    return api.cleanup.onProgress((progress) => setStep({ name: 'running', progress }));
  }, [step.name]);

  const selected = (categories ?? [])
    .map((category) => ({ category, ...selectionCount(category, selections[category.id]) }))
    .filter((entry) => entry.count > 0);
  const totalCount = selected.reduce((sum, entry) => sum + entry.count, 0);
  const totalSize = selected.reduce((sum, entry) => sum + entry.size, 0);

  const requestSelections = (): CleanupSelection[] =>
    selected.map(({ category }) => {
      const selection = selections[category.id]!;
      return { categoryId: category.id, mode: selection.mode, paths: Object.keys(selection.paths) };
    });

  const review = async () => {
    try {
      const preview = await api.cleanup.preview(requestSelections());
      if (!preview.allowsPermanent) setMode('trash');
      setStep({ name: 'review', preview });
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  const execute = async () => {
    setStep({ name: 'running', progress: null });
    try {
      const result = await api.cleanup.execute({ selections: requestSelections(), mode });
      setStep({ name: 'done', result });
      setSelections({});
      void refreshVolumes();
    } catch (error) {
      toast('error', errorMessage(error));
      setStep({ name: 'closed' });
    }
  };

  const closeDialog = () => {
    const wasDone = step.name === 'done';
    setStep({ name: 'closed' });
    if (wasDone) void load(false);
  };

  const recycle = categories?.find((category) => category.kind === 'recycle-bin');
  const others = categories?.filter((category) => category.kind !== 'recycle-bin') ?? [];
  const verb = mode === 'trash' ? 'Enviar' : 'Excluir';
  const confirmLabel =
    step.name === 'review'
      ? `${verb} ${plural(step.preview.totalCount, 'arquivo', 'arquivos')}${mode === 'trash' ? ' para a Lixeira' : ' permanentemente'}`
      : '';

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Limpeza</h1>
          <p>Itens de baixo risco, com explicação. Nada vem marcado: revise, escolha e confirme. Pastas do Windows e de programas nunca são tocadas.</p>
        </div>
        <button type="button" className="btn" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw size={15} aria-hidden /> Procurar novamente
        </button>
      </header>

      {!categories || loading ? (
        <div className="card">
          <Loading text="Procurando arquivos temporários e caches…" />
        </div>
      ) : (
        <div className="stack">
          {others.map((category) => (
            <CleanupCategoryCard
              key={category.id}
              category={category}
              selection={selections[category.id]}
              onChange={(selection) => setSelections((current) => ({ ...current, [category.id]: selection }))}
            />
          ))}
          {recycle && <RecycleBinCard category={recycle} onChanged={() => void load(true)} />}

          {totalCount > 0 && (
            <div className="selection-bar" role="region" aria-label="Seleção para limpeza">
              <Trash2 size={18} aria-hidden />
              <div>
                <div className="total">
                  {plural(totalCount, 'arquivo selecionado', 'arquivos selecionados')} · {formatBytes(totalSize)}
                </div>
                <div className="subtle">Estimativa. O espaço recuperado real aparece depois da limpeza.</div>
              </div>
              <span className="spacer" />
              <button type="button" className="btn ghost" onClick={() => setSelections({})}>
                Limpar seleção
              </button>
              <button type="button" className="btn primary" onClick={() => void review()}>
                Revisar e confirmar…
              </button>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={step.name !== 'closed'}
        busy={step.name === 'running'}
        title={step.name === 'done' ? 'Limpeza concluída' : step.name === 'running' ? 'Limpando…' : 'Confirmar limpeza'}
        description={step.name === 'review' ? 'Confira o resumo. Arquivos em uso ou alterados desde a revisão serão ignorados.' : undefined}
        onClose={closeDialog}
        footer={
          step.name === 'review' ? (
            <>
              <button type="button" className="btn" onClick={closeDialog}>
                Cancelar
              </button>
              <button type="button" className={`btn ${mode === 'permanent' ? 'danger' : 'primary'}`} onClick={() => void execute()}>
                {confirmLabel}
              </button>
            </>
          ) : step.name === 'done' ? (
            <button type="button" className="btn primary" onClick={closeDialog}>
              Fechar
            </button>
          ) : (
            <span className="subtle">Aguarde…</span>
          )
        }
      >
        {step.name === 'review' && (
          <>
            <div className="summary-list">
              {step.preview.groups.map((group) => (
                <div key={group.categoryId}>
                  <span>{group.title}</span>
                  <strong className="num">
                    {plural(group.count, 'arquivo', 'arquivos')} · {formatBytes(group.size)}
                  </strong>
                </div>
              ))}
              <div>
                <strong>Total estimado</strong>
                <strong className="num">{formatBytes(step.preview.totalSize)}</strong>
              </div>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
              <legend className="field-label" style={{ marginBottom: 8 }}>
                O que fazer com os arquivos
              </legend>
              <label className="radio-card">
                <input type="radio" name="mode" checked={mode === 'trash'} onChange={() => setMode('trash')} />
                <span>
                  <span className="title">Enviar para a Lixeira (recomendado)</span>
                  <span className="desc" style={{ display: 'block' }}>
                    Dá para recuperar depois. O espaço só é liberado quando a Lixeira for esvaziada.
                  </span>
                </span>
              </label>
              <label className="radio-card" style={{ opacity: step.preview.allowsPermanent ? 1 : 0.55 }}>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'permanent'}
                  disabled={!step.preview.allowsPermanent}
                  onChange={() => setMode('permanent')}
                />
                <span>
                  <span className="title">Excluir permanentemente</span>
                  <span className="desc" style={{ display: 'block' }}>
                    {step.preview.allowsPermanent
                      ? 'Libera o espaço na hora, mas não pode ser desfeito.'
                      : 'Indisponível: a seleção inclui arquivos pessoais, que só podem ir para a Lixeira.'}
                  </span>
                </span>
              </label>
            </fieldset>
            {mode === 'permanent' && <Notice kind="danger">Os arquivos não irão para a Lixeira e não poderão ser recuperados.</Notice>}
          </>
        )}
        {step.name === 'running' && (
          <div className="progress-panel">
            <Meter
              value={step.progress && step.progress.total ? step.progress.done / step.progress.total : 0}
              indeterminate={!step.progress}
              label="Progresso da limpeza"
            />
            <div className="muted">
              {step.progress ? `${step.progress.done} de ${step.progress.total} arquivos` : 'Verificando os arquivos…'}
            </div>
            {step.progress?.currentPath && (
              <div className="current" title={step.progress.currentPath}>
                {step.progress.currentPath}
              </div>
            )}
          </div>
        )}
        {step.name === 'done' && (
          <OperationResult
            status={step.result.status}
            headline={
              step.result.mode === 'trash'
                ? `${plural(step.result.removedCount, 'arquivo enviado', 'arquivos enviados')} para a Lixeira`
                : `${plural(step.result.removedCount, 'arquivo excluído', 'arquivos excluídos')} permanentemente`
            }
            lines={[
              { label: 'Tamanho dos arquivos removidos', value: formatBytes(step.result.removedSize) },
              {
                label: 'Espaço livre ganho (medido)',
                value: step.result.freedBytes === null ? 'Não medido' : formatBytes(step.result.freedBytes),
              },
            ]}
            failed={step.result.failed}
            skipped={step.result.skipped}
          >
            {step.result.mode === 'trash' && step.result.removedCount > 0 && (
              <Notice kind="info">
                Os arquivos estão na Lixeira e ainda ocupam espaço. Para liberar de vez, esvazie a Lixeira (nesta tela, mais abaixo).
              </Notice>
            )}
          </OperationResult>
        )}
      </Dialog>
    </div>
  );
}
