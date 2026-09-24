import { win32 } from 'node:path';
import { extensionOf } from '@shared/categories';
import type { TransferClassification } from '@shared/types';

/** Well-known Windows locations, resolved once at startup (injected for tests). */
export interface KnownPaths {
  systemDrive: string;
  systemRoot: string;
  programFiles: string[];
  programData: string;
  home: string;
  appData: string;
  localAppData: string;
  temp: string;
  desktop: string;
  documents: string;
  downloads: string;
  pictures: string;
  videos: string;
  music: string;
  /** OneDrive, Dropbox and similar synchronized roots. */
  syncedRoots: { label: string; path: string }[];
}

/** Folders at the root of any volume that belong to Windows. */
const VOLUME_SYSTEM_FOLDERS = [
  '$recycle.bin',
  'system volume information',
  'recovery',
  '$windows.~bt',
  '$windows.~ws',
  '$winreagent',
  '$sysreset',
  '$getcurrent',
  'config.msi',
  'windows.old',
  'perflogs',
  'onedrivetemp',
  'msocache',
  'boot',
  'efi',
];

const VOLUME_SYSTEM_FILES = [
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log',
  'dumpstack.log.tmp',
  'bootmgr',
  'bootnxt',
];

/** Folder names that mark installed apps, games or tool internals anywhere in a path. */
const APP_SEGMENTS = new Set([
  'windowsapps',
  'steamapps',
  'steamlibrary',
  'epic games',
  'xboxgames',
  'riot games',
  'ea games',
  'origin games',
  'gog galaxy',
  'gog games',
  'ubisoft game launcher',
  'battle.net',
  'node_modules',
]);

const BLOCKED_EXTENSIONS = new Set(['dll', 'sys', 'drv', 'ocx', 'cpl', 'mui', 'efi', 'cat', 'inf']);

/** Normalizes to an absolute Windows path without the long-path prefix or a trailing separator. */
export function normalizePath(input: string): string {
  let value = input.trim();
  if (value.startsWith('\\\\?\\UNC\\')) value = '\\\\' + value.slice(8);
  else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  let resolved = win32.resolve(value);
  if (resolved.length > 3 && /[\\/]$/.test(resolved)) resolved = resolved.slice(0, -1);
  if (/^[a-z]:/.test(resolved)) resolved = resolved[0].toUpperCase() + resolved.slice(1);
  return resolved;
}

export function isDrivePath(value: string): boolean {
  return /^[a-zA-Z]:\\/.test(value);
}

/** Case-insensitive "child is parent or inside parent". */
export function isWithin(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  if (c === p) return true;
  const prefix = p.endsWith('\\') ? p : p + '\\';
  return c.startsWith(prefix);
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/** "C:\\" for drive paths, "\\\\server\\share\\" for UNC paths. */
export function volumeRootOf(value: string): string {
  const root = win32.parse(normalizePath(value)).root;
  return /^[a-z]:\\$/i.test(root) ? root.toUpperCase() : root;
}

/** Returns why a path must never be modified by the app, or null when no rule applies. */
export function protectedReason(target: string, known: KnownPaths): string | null {
  const value = normalizePath(target);
  if (!isDrivePath(value)) return 'Somente caminhos em discos com letra (ex.: C:\\) são suportados.';
  if (isWithin(value, known.systemRoot)) return 'Pasta do Windows (arquivos de sistema).';
  for (const programFiles of known.programFiles) {
    if (isWithin(value, programFiles)) return 'Pasta de programas instalados.';
  }
  if (isWithin(value, known.programData)) return 'Dados de programas (ProgramData).';
  if (isWithin(value, win32.join(known.home, 'AppData'))) return 'Dados de aplicativos (AppData).';

  const root = volumeRootOf(value);
  const relative = value.slice(root.length).toLowerCase();
  const first = relative.split('\\')[0];
  if (first && VOLUME_SYSTEM_FOLDERS.includes(first)) return 'Pasta reservada do Windows.';
  // Program folders and Windows folders on other volumes (e.g. D:\Program Files).
  if (first === 'windows' || first === 'program files' || first === 'program files (x86)' || first === 'programdata') {
    return 'Pasta de sistema ou de programas.';
  }
  return null;
}

function isPersonalFolder(value: string, known: KnownPaths): boolean {
  const folders = [known.desktop, known.documents, known.downloads, known.pictures, known.videos, known.music];
  return folders.some((folder) => folder && isWithin(value, folder));
}

/**
 * Path-only rules for moving a file to another disk. File-system checks (exists,
 * regular file, no junction in the path) happen separately, right before acting.
 */
export function classifyTransferSource(target: string, known: KnownPaths): TransferClassification {
  const value = normalizePath(target);
  const result: TransferClassification = { path: value, eligible: false, warnings: [], personal: false, synced: false };

  const protectedWhy = protectedReason(value, known);
  if (protectedWhy) {
    result.blockedReason = protectedWhy;
    return result;
  }

  const root = volumeRootOf(value);
  const segments = value.slice(root.length).split('\\');
  const fileName = segments[segments.length - 1] ?? '';
  const folders = segments.slice(0, -1);

  if (folders.length === 0 && VOLUME_SYSTEM_FILES.includes(fileName.toLowerCase())) {
    result.blockedReason = 'Arquivo de sistema do Windows.';
    return result;
  }
  const appFolder = folders.find((segment) => APP_SEGMENTS.has(segment.toLowerCase()));
  if (appFolder) {
    result.blockedReason = `Faz parte de um aplicativo ou jogo instalado (${appFolder}).`;
    return result;
  }
  if (folders.some((segment) => segment.startsWith('.'))) {
    result.blockedReason = 'Está em uma pasta de configuração de programa (nome iniciado por ponto).';
    return result;
  }
  const extension = extensionOf(fileName);
  if (BLOCKED_EXTENSIONS.has(extension)) {
    result.blockedReason = 'Arquivo de programa ou de sistema.';
    return result;
  }

  result.eligible = true;
  result.personal = isPersonalFolder(value, known);

  const synced = known.syncedRoots.find((root) => isWithin(value, root.path));
  if (synced) {
    result.synced = true;
    result.warnings.push(
      `Sincronizado com ${synced.label}: ao sair da pasta sincronizada, o arquivo pode ser removido da nuvem e dos outros dispositivos.`,
    );
  }
  if (!result.personal && !synced) {
    result.warnings.push(
      isWithin(value, known.home)
        ? 'Fora das pastas pessoais (Documentos, Imagens, Vídeos…): confirme que não é usado por um programa.'
        : 'Fora da pasta do usuário: confirme que não pertence a um programa.',
    );
  }
  if (extension === 'pst' || extension === 'ost') {
    result.warnings.push('Arquivo de dados do Outlook: feche o Outlook e aponte-o para o novo local depois.');
  }
  if (['vhd', 'vhdx', 'vmdk', 'vdi', 'qcow2'].includes(extension)) {
    result.warnings.push('Disco de máquina virtual: o programa de virtualização precisará ser apontado para o novo local.');
  }
  return result;
}

/** Relative location kept under the destination when "preserve structure" is on. */
export function relativeDestination(source: string, known: KnownPaths): string {
  const value = normalizePath(source);
  if (isWithin(value, known.home)) return value.slice(normalizePath(known.home).length + 1);
  const root = volumeRootOf(value);
  const letter = root.replace(/[:\\]/g, '');
  return win32.join(`Disco ${letter}`, value.slice(root.length));
}
