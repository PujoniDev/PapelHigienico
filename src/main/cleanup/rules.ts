import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { categoryOf } from '@shared/categories';
import type { CleanupCategoryId, RiskLevel } from '@shared/types';
import { isWithin, normalizePath, type KnownPaths } from '../policy';

const MB = 1024 * 1024;

export interface CleanupSourceDef {
  id: string;
  label: string;
  /** Folders whose files belong to this source. Only existing folders are kept. */
  roots: string[];
  /** Files created or modified more recently than this are left alone. */
  minAgeDays: number;
  minSize: number;
  recursive: boolean;
  /** Lower-case process image names that must not be running (e.g. "chrome.exe"). */
  processNames?: string[];
  appName?: string;
  match?: (name: string) => boolean;
}

export interface CleanupCategoryDef {
  id: CleanupCategoryId;
  title: string;
  description: string;
  risk: RiskLevel;
  riskReason: string;
  kind: 'files' | 'review' | 'recycle-bin';
  allowsPermanent: boolean;
  notes: string[];
  maxItems: number;
  sources(known: KnownPaths): CleanupSourceDef[];
  tag?(name: string): string | undefined;
}

function existing(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

/** Chromium keeps caches per profile ("Default", "Profile 1"…) plus a few shared ones. */
function chromiumCacheRoots(userData: string): string[] {
  if (!existsSync(userData)) return [];
  const roots = [join(userData, 'ShaderCache'), join(userData, 'GrShaderCache')];
  let profiles: string[] = [];
  try {
    profiles = readdirSync(userData, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+|Guest Profile)$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    // Unreadable profile folder: nothing to offer.
  }
  for (const profile of profiles) {
    for (const cache of ['Cache', 'Code Cache', 'GPUCache']) roots.push(join(userData, profile, cache));
  }
  return existing(roots);
}

function firefoxCacheRoots(localAppData: string): string[] {
  const profilesDir = join(localAppData, 'Mozilla', 'Firefox', 'Profiles');
  if (!existsSync(profilesDir)) return [];
  try {
    return existing(
      readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(profilesDir, entry.name, 'cache2')),
    );
  } catch {
    return [];
  }
}

/**
 * The user's temp folder is cleaned only when it is the standard one inside
 * %LOCALAPPDATA%; an unusual TEMP (e.g. a drive root) is never touched.
 */
export function safeTempRoot(known: KnownPaths): string | null {
  const temp = normalizePath(known.temp);
  if (!isWithin(temp, known.localAppData) || temp.toLowerCase() === known.localAppData.toLowerCase()) return null;
  return /\\te?mp$/i.test(temp) ? temp : null;
}

export const CLEANUP_CATEGORIES: CleanupCategoryDef[] = [
  {
    id: 'user-temp',
    title: 'Arquivos temporários do usuário',
    description:
      'Arquivos que programas deixaram na pasta temporária do Windows e que não foram criados nem alterados nos últimos 7 dias.',
    risk: 'low',
    riskReason: 'Pasta temporária padrão do Windows. Arquivos em uso são ignorados.',
    kind: 'files',
    allowsPermanent: true,
    notes: ['Arquivos usados por programas abertos não podem ser removidos e serão ignorados.'],
    maxItems: 100_000,
    sources(known) {
      const temp = safeTempRoot(known);
      return [
        {
          id: 'temp',
          label: 'Pasta temporária (%TEMP%)',
          roots: temp ? existing([temp]) : [],
          minAgeDays: 7,
          minSize: 0,
          recursive: true,
        },
      ];
    },
  },
  {
    id: 'crash-reports',
    title: 'Relatórios de erro e despejos de memória',
    description:
      'Relatórios de erros de programas e cópias de memória gravadas quando um programa travou. Servem apenas para diagnóstico.',
    risk: 'low',
    riskReason: 'Usados só para diagnóstico. O Windows cria novos se algo travar de novo.',
    kind: 'files',
    allowsPermanent: true,
    notes: [],
    maxItems: 50_000,
    sources(known) {
      const wer = join(known.localAppData, 'Microsoft', 'Windows', 'WER');
      return [
        {
          id: 'crash-dumps',
          label: 'Despejos de falha (CrashDumps)',
          roots: existing([join(known.localAppData, 'CrashDumps')]),
          minAgeDays: 1,
          minSize: 0,
          recursive: false,
          match: (name) => name.toLowerCase().endsWith('.dmp'),
        },
        {
          id: 'wer',
          label: 'Relatórios de erro do Windows',
          roots: existing([join(wer, 'ReportArchive'), join(wer, 'ReportQueue')]),
          minAgeDays: 1,
          minSize: 0,
          recursive: true,
        },
      ];
    },
  },
  {
    id: 'app-cache',
    title: 'Cache de navegadores e de gráficos',
    description:
      'Cópias temporárias de páginas e de sombreadores gráficos (shaders) que os aplicativos recriam automaticamente.',
    risk: 'medium',
    riskReason: 'O aplicativo recria o cache; sites e jogos podem abrir mais devagar na primeira vez.',
    kind: 'files',
    allowsPermanent: true,
    notes: [
      'Feche o navegador antes de limpar o cache dele. O LimpaC não fecha programas.',
      'Senhas, favoritos, histórico e cookies não são afetados.',
    ],
    maxItems: 200_000,
    sources(known) {
      const local = known.localAppData;
      return [
        {
          id: 'chrome',
          label: 'Google Chrome',
          appName: 'Google Chrome',
          roots: chromiumCacheRoots(join(local, 'Google', 'Chrome', 'User Data')),
          minAgeDays: 0,
          minSize: 0,
          recursive: true,
          processNames: ['chrome.exe'],
        },
        {
          id: 'edge',
          label: 'Microsoft Edge',
          appName: 'Microsoft Edge',
          roots: chromiumCacheRoots(join(local, 'Microsoft', 'Edge', 'User Data')),
          minAgeDays: 0,
          minSize: 0,
          recursive: true,
          processNames: ['msedge.exe'],
        },
        {
          id: 'firefox',
          label: 'Mozilla Firefox',
          appName: 'Firefox',
          roots: firefoxCacheRoots(local),
          minAgeDays: 0,
          minSize: 0,
          recursive: true,
          processNames: ['firefox.exe'],
        },
        {
          id: 'directx',
          label: 'Cache de sombreadores do DirectX',
          roots: existing([join(local, 'D3DSCache')]),
          minAgeDays: 1,
          minSize: 0,
          recursive: true,
        },
        {
          id: 'nvidia',
          label: 'Cache de sombreadores da NVIDIA',
          roots: existing([join(local, 'NVIDIA', 'DXCache'), join(local, 'NVIDIA', 'GLCache')]),
          minAgeDays: 1,
          minSize: 0,
          recursive: true,
        },
      ];
    },
  },
  {
    id: 'recycle-bin',
    title: 'Lixeira',
    description: 'Itens que você já excluiu. Eles continuam ocupando espaço até a Lixeira ser esvaziada.',
    risk: 'high',
    riskReason: 'Esvaziar a Lixeira apaga os itens definitivamente.',
    kind: 'recycle-bin',
    allowsPermanent: false,
    notes: [],
    maxItems: 0,
    sources: () => [],
  },
  {
    id: 'downloads',
    title: 'Downloads e instaladores',
    description:
      'Arquivos maiores que 1 MB na pasta Downloads, com destaque para instaladores e arquivos compactados. São arquivos pessoais: revise um a um.',
    risk: 'review',
    riskReason: 'São seus arquivos. Nada é selecionado automaticamente.',
    kind: 'review',
    allowsPermanent: false,
    notes: ['Os itens escolhidos vão para a Lixeira.'],
    maxItems: 2_000,
    sources(known) {
      return [
        {
          id: 'downloads',
          label: 'Downloads',
          roots: existing([known.downloads]),
          minAgeDays: 0,
          minSize: MB,
          recursive: true,
        },
      ];
    },
    tag(name) {
      switch (categoryOf(name)) {
        case 'installer':
          return 'Instalador';
        case 'archive':
          return 'Compactado';
        case 'diskImage':
          return 'Imagem de disco';
        case 'video':
          return 'Vídeo';
        default:
          return undefined;
      }
    },
  },
];
