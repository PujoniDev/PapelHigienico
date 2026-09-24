import { useEffect, useMemo, useState } from 'react';
import { AppWindow, ExternalLink, RefreshCw, Search } from 'lucide-react';
import { formatBytes, plural } from '@shared/format';
import type { InstalledApp } from '@shared/types';
import { api, errorMessage } from '../api';
import { Dialog, EmptyState, Loading, Notice } from '../components/ui';
import { useApp } from '../store';

type Sort = 'size' | 'name';

export function Apps() {
  const toast = useApp((state) => state.toast);
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('size');
  const [target, setTarget] = useState<InstalledApp | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setApps(null);
    setError(null);
    try {
      setApps(await api.apps.list());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (apps ?? []).filter(
      (app) => !needle || app.name.toLowerCase().includes(needle) || app.publisher.toLowerCase().includes(needle),
    );
    return filtered.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, 'pt-BR') : (b.size ?? -1) - (a.size ?? -1) || a.name.localeCompare(b.name, 'pt-BR'),
    );
  }, [apps, search, sort]);

  const uninstall = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const result = await api.apps.uninstall(target.id);
      toast(result.launched ? 'info' : 'error', result.message);
      setTarget(null);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openSettings = () => void api.apps.openSettings().catch((err) => toast('error', errorMessage(err)));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Aplicativos</h1>
          <p>
            Para liberar espaço removendo programas, use sempre o desinstalador oficial. O LimpaC não apaga pastas de programas como
            substituto da desinstalação.
          </p>
        </div>
        <button type="button" className="btn" onClick={openSettings}>
          <ExternalLink size={15} aria-hidden /> Abrir Aplicativos instalados do Windows
        </button>
      </header>

      <div className="stack">
        <Notice kind="neutral">
          O tamanho é informado pelo próprio aplicativo e pode estar ausente ou desatualizado. Aplicativos da Microsoft Store aparecem
          apenas nas Configurações do Windows.
        </Notice>

        <section className="card flush" aria-labelledby="apps-title">
          <div className="card-header" style={{ paddingBottom: 12 }}>
            <h2 id="apps-title">{apps ? plural(visible.length, 'aplicativo', 'aplicativos') : 'Aplicativos instalados'}</h2>
            <div className="row">
              <label className="search">
                <Search size={15} aria-hidden />
                <span className="visually-hidden">Buscar aplicativo</span>
                <input
                  className="input"
                  type="search"
                  placeholder="Buscar por nome ou editor"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label className="row" style={{ gap: 6 }}>
                <span className="subtle">Ordenar</span>
                <select className="select" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                  <option value="size">Maior tamanho</option>
                  <option value="name">Nome</option>
                </select>
              </label>
              <button type="button" className="btn small" onClick={() => void load()}>
                <RefreshCw size={14} aria-hidden /> Atualizar
              </button>
            </div>
          </div>
          {error ? (
            <div style={{ padding: 16 }}>
              <Notice kind="danger">Não foi possível listar os aplicativos: {error}</Notice>
            </div>
          ) : !apps ? (
            <Loading text="Lendo a lista de aplicativos do Windows…" />
          ) : visible.length === 0 ? (
            <EmptyState icon={<AppWindow size={26} />} title="Nenhum aplicativo encontrado" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Aplicativos instalados</caption>
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Versão</th>
                    <th>Instalado em</th>
                    <th className="right">Tamanho</th>
                    <th>
                      <span className="visually-hidden">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((app) => (
                    <tr key={app.id}>
                      <td className="name-cell">
                        <span className="truncate" title={app.name} style={{ fontWeight: 550 }}>
                          {app.name}
                        </span>
                        {app.publisher && <span className="path">{app.publisher}</span>}
                      </td>
                      <td className="subtle">{app.version || '—'}</td>
                      <td className="subtle num">{app.installDate ?? '—'}</td>
                      <td className="right">{app.size !== null ? formatBytes(app.size) : <span className="subtle">Tamanho não informado</span>}</td>
                      <td className="right">
                        <button
                          type="button"
                          className="btn small"
                          disabled={!app.canUninstall}
                          title={app.canUninstall ? undefined : 'Este aplicativo não registrou um desinstalador'}
                          onClick={() => setTarget(app)}
                        >
                          Desinstalar…
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={target !== null}
        busy={busy}
        title={target ? `Desinstalar ${target.name}?` : ''}
        description="O LimpaC vai abrir o desinstalador do próprio aplicativo."
        onClose={() => setTarget(null)}
        footer={
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setTarget(null)}>
              Cancelar
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void uninstall()}>
              {busy ? 'Abrindo…' : 'Abrir desinstalador'}
            </button>
          </>
        }
      >
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>O Windows pode pedir permissão de administrador.</li>
          <li>Siga as instruções do desinstalador para concluir. Você pode cancelar por lá.</li>
          <li>Depois, clique em “Atualizar” para ver a lista nova.</li>
        </ul>
      </Dialog>
    </div>
  );
}
