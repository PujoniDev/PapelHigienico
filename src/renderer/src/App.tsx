import { useEffect, type ComponentType } from 'react';
import {
  AppWindow,
  ArrowRightLeft,
  CheckCircle2,
  History as HistoryIcon,
  HardDrive,
  Info,
  LayoutDashboard,
  OctagonAlert,
  Settings as SettingsIcon,
  Sparkles,
  X,
  FolderSearch,
} from 'lucide-react';
import { formatPercent } from '@shared/format';
import { Loading, Notice } from './components/ui';
import { Analyze } from './screens/Analyze';
import { Apps } from './screens/Apps';
import { Cleanup } from './screens/Cleanup';
import { History } from './screens/History';
import { Overview } from './screens/Overview';
import { SettingsScreen } from './screens/Settings';
import { Transfer } from './screens/Transfer';
import { useApp, type Route } from './store';

const NAV: { route: Route; label: string; icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }> }[] = [
  { route: 'overview', label: 'Visão geral', icon: LayoutDashboard },
  { route: 'analyze', label: 'Analisar disco', icon: FolderSearch },
  { route: 'cleanup', label: 'Limpeza', icon: Sparkles },
  { route: 'transfer', label: 'Mover arquivos', icon: ArrowRightLeft },
  { route: 'apps', label: 'Aplicativos', icon: AppWindow },
  { route: 'history', label: 'Histórico', icon: HistoryIcon },
  { route: 'settings', label: 'Configurações', icon: SettingsIcon },
];

const SCREENS: Record<Route, ComponentType> = {
  overview: Overview,
  analyze: Analyze,
  cleanup: Cleanup,
  transfer: Transfer,
  apps: Apps,
  history: History,
  settings: SettingsScreen,
};

function Sidebar() {
  const route = useApp((state) => state.route);
  const navigate = useApp((state) => state.navigate);
  const scan = useApp((state) => state.scan);
  const transferProgress = useApp((state) => state.transferProgress);
  const selected = useApp((state) => Object.keys(state.transferSelection).length);
  const version = useApp((state) => state.info?.version);

  return (
    <nav className="sidebar" aria-label="Navegação principal">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <HardDrive size={16} />
        </span>
        LimpaC
      </div>
      <div className="nav">
        {NAV.map(({ route: target, label, icon: Icon }) => (
          <button
            key={target}
            type="button"
            className="nav-item"
            aria-current={route === target ? 'page' : undefined}
            onClick={() => navigate(target)}
          >
            <Icon size={17} aria-hidden />
            {label}
            {target === 'transfer' && selected > 0 && (
              <span className="nav-badge" aria-label={`${selected} selecionados`}>
                {selected}
              </span>
            )}
          </button>
        ))}
      </div>
      {scan.status === 'running' && (
        <button type="button" className="sidebar-activity" onClick={() => navigate('analyze')}>
          <strong>Analisando {scan.progress.root}</strong>
          <div className="subtle">
            {scan.progress.estimatedRatio !== null ? `cerca de ${formatPercent(scan.progress.estimatedRatio)}` : 'em andamento'}
          </div>
        </button>
      )}
      {transferProgress && (
        <button type="button" className="sidebar-activity" onClick={() => navigate('transfer')}>
          <strong>Copiando arquivos</strong>
          <div className="subtle">
            {transferProgress.bytesTotal > 0 ? formatPercent(transferProgress.bytesDone / transferProgress.bytesTotal) : ''}
          </div>
        </button>
      )}
      <div className="sidebar-footer">
        Versão {version ?? '—'}
        <br />
        Nada é enviado para a internet.
      </div>
    </nav>
  );
}

function Toasts() {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? OctagonAlert : Info;
        return (
          <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
            <Icon size={17} aria-hidden />
            <p>{toast.text}</p>
            <button type="button" aria-label="Fechar aviso" onClick={() => dismiss(toast.id)}>
              <X size={15} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const ready = useApp((state) => state.ready);
  const route = useApp((state) => state.route);
  const init = useApp((state) => state.init);
  const info = useApp((state) => state.info);

  useEffect(() => {
    void init();
  }, [init]);

  const Screen = SCREENS[route];
  return (
    <div className="app">
      <Sidebar />
      <main className="main" id="conteudo">
        {!ready ? (
          <div className="page">
            <Loading text="Abrindo…" />
          </div>
        ) : (
          <>
            {info && !info.platformSupported && (
              <div className="page" style={{ paddingBottom: 0 }}>
                <Notice kind="warn">Este aplicativo foi feito para Windows. Alguns recursos não funcionam neste sistema.</Notice>
              </div>
            )}
            <Screen key={route} />
          </>
        )}
      </main>
      <Toasts />
    </div>
  );
}
