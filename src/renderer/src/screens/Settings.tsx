import { useState } from 'react';
import { Lock } from 'lucide-react';
import type { ThemePreference } from '@shared/types';
import { api, errorMessage } from '../api';
import { volumeName } from '../components/VolumeUsageCard';
import { Checkbox, Dialog, Notice } from '../components/ui';
import { useApp } from '../store';

const THRESHOLDS = [100, 250, 500, 1000, 2000];

export function SettingsScreen() {
  const settings = useApp((state) => state.settings);
  const info = useApp((state) => state.info);
  const volumes = useApp((state) => state.volumes);
  const update = useApp((state) => state.updateSettings);
  const toast = useApp((state) => state.toast);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!settings) return null;

  const clearHistory = async () => {
    setBusy(true);
    try {
      await api.history.clear();
      toast('success', 'Histórico apagado.');
      setConfirmClear(false);
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const themes: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'Igual ao Windows' },
    { value: 'light', label: 'Claro' },
    { value: 'dark', label: 'Escuro' },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Configurações</h1>
          <p>As alterações são salvas automaticamente.</p>
        </div>
      </header>

      <div className="stack" style={{ maxWidth: 760 }}>
        <section className="card stack" aria-labelledby="set-analysis">
          <h2 id="set-analysis">Análise</h2>
          <div className="field">
            <label htmlFor="default-volume">Disco padrão</label>
            <select
              id="default-volume"
              className="select"
              style={{ maxWidth: 360 }}
              value={settings.defaultVolume}
              onChange={(event) => void update({ defaultVolume: event.target.value })}
            >
              {volumes
                .filter((volume) => volume.type === 'fixed' || volume.type === 'removable')
                .map((volume) => (
                  <option key={volume.root} value={volume.root}>
                    {volumeName(volume)}
                  </option>
                ))}
            </select>
            <span className="hint">Usado na Visão geral e sugerido ao iniciar uma análise.</span>
          </div>
          <div className="field">
            <label htmlFor="threshold">O que conta como “arquivo grande”</label>
            <select
              id="threshold"
              className="select"
              style={{ maxWidth: 360 }}
              value={settings.largeFileThresholdMB}
              onChange={(event) => void update({ largeFileThresholdMB: Number(event.target.value) })}
            >
              {THRESHOLDS.map((value) => (
                <option key={value} value={value}>
                  Mais de {value >= 1000 ? `${value / 1000} GB` : `${value} MB`}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="card stack" aria-labelledby="set-confirm">
          <h2 id="set-confirm">Confirmações</h2>
          <div className="row" style={{ gap: 8 }}>
            <Lock size={15} aria-hidden style={{ color: 'var(--text-3)' }} />
            <span>Confirmar antes de excluir ou enviar para a Lixeira</span>
            <span className="badge">Sempre ativado</span>
          </div>
          <Checkbox
            checked={settings.confirmTransfers}
            onChange={(confirmTransfers) => void update({ confirmTransfers })}
            label="Mostrar a revisão antes de copiar arquivos para outro disco"
          />
          <p className="subtle">
            Mesmo desligada, a revisão aparece quando houver nomes repetidos, arquivos sincronizados ou algum problema.
          </p>
        </section>

        <section className="card stack" aria-labelledby="set-theme">
          <h2 id="set-theme">Aparência</h2>
          <div className="row" role="radiogroup" aria-labelledby="set-theme">
            {themes.map((theme) => (
              <label key={theme.value} className="radio-card" style={{ flex: '1 1 160px' }}>
                <input
                  type="radio"
                  name="theme"
                  checked={settings.theme === theme.value}
                  onChange={() => void update({ theme: theme.value })}
                />
                <span className="title">{theme.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="card stack" aria-labelledby="set-history">
          <h2 id="set-history">Histórico</h2>
          <div className="field">
            <span className="field-label">Local</span>
            <div className="full-path">
              {info?.historyPath}
            </div>
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={() => void api.history.openFolder().catch((e) => toast('error', errorMessage(e)))}>
              Abrir pasta
            </button>
            <button type="button" className="btn danger-outline" onClick={() => setConfirmClear(true)}>
              Apagar histórico…
            </button>
          </div>
        </section>

        <section className="card stack" aria-labelledby="set-about">
          <h2 id="set-about">Sobre</h2>
          <p className="muted">
            LimpaC {info?.version}. Funciona sem conta e sem internet: nenhum dado sai deste computador. A análise lê apenas nomes,
            tamanhos e datas; o conteúdo dos arquivos só é lido para conferir cópias durante uma transferência.
          </p>
          {info && !info.nativeReader && (
            <Notice kind="warn">
              A leitura rápida do disco não está disponível; a análise usa um modo de compatibilidade mais lento e sem detecção de
              arquivos ocultos.
            </Notice>
          )}
        </section>
      </div>

      <Dialog
        open={confirmClear}
        busy={busy}
        title="Apagar o histórico?"
        description="O registro de operações e os relatórios serão apagados deste computador."
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmClear(false)}>
              Cancelar
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void clearHistory()}>
              Apagar histórico
            </button>
          </>
        }
      >
        <Notice kind="warn">Transferências antigas deixam de aparecer aqui e não poderão mais ser desfeitas pelo LimpaC.</Notice>
      </Dialog>
    </div>
  );
}
