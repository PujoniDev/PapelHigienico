import type { InstalledApp, UninstallResult } from '@shared/types';
import { runPowerShell } from './powershell';

interface RegistryApp {
  Hive: string;
  Key: string;
  DisplayName?: string | null;
  Publisher?: string | null;
  DisplayVersion?: string | null;
  EstimatedSize?: number | null;
  InstallDate?: string | null;
  UninstallString?: string | null;
  SystemComponent?: number | null;
  ParentKeyName?: string | null;
  ReleaseType?: string | null;
  WindowsInstaller?: number | null;
  NoRemove?: number | null;
}

const LIST_SCRIPT = `
$sources = @(
  @{ Hive = 'HKLM64'; Path = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Hive = 'HKLM32'; Path = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Hive = 'HKCU'; Path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }
)
$apps = foreach ($source in $sources) {
  Get-ItemProperty -Path $source.Path -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      Hive = $source.Hive
      Key = $_.PSChildName
      DisplayName = $_.DisplayName
      Publisher = $_.Publisher
      DisplayVersion = $_.DisplayVersion
      EstimatedSize = $_.EstimatedSize
      InstallDate = $_.InstallDate
      UninstallString = $_.UninstallString
      SystemComponent = $_.SystemComponent
      ParentKeyName = $_.ParentKeyName
      ReleaseType = $_.ReleaseType
      WindowsInstaller = $_.WindowsInstaller
      NoRemove = $_.NoRemove
    }
  }
}
ConvertTo-Json -InputObject @($apps) -Depth 2 -Compress
`;

const LAUNCH_SCRIPT = `
$file = $env:LIMPAC_UNINSTALL_FILE
$arguments = $env:LIMPAC_UNINSTALL_ARGS
if ([string]::IsNullOrWhiteSpace($arguments)) { Start-Process -FilePath $file }
else { Start-Process -FilePath $file -ArgumentList $arguments }
`;

/** Splits a registry command line into the program and its arguments. */
export function parseCommandLine(command: string): { file: string; args: string } | null {
  const value = command.trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    if (end < 0) return null;
    return { file: value.slice(1, end), args: value.slice(end + 1).trim() };
  }
  // Unquoted paths with spaces are common ("C:\Program Files\X\uninst.exe /S").
  const exe = /^(.+?\.exe)(?=\s|$)(.*)$/i.exec(value);
  if (exe) return { file: exe[1], args: exe[2].trim() };
  const space = value.indexOf(' ');
  return space < 0 ? { file: value, args: '' } : { file: value.slice(0, space), args: value.slice(space + 1).trim() };
}

const MSI_PRODUCT = /^\{[0-9A-F-]{36}\}$/i;

/** Program and arguments that start the uninstaller the app registered for itself. */
export function uninstallCommand(app: RegistryApp): { file: string; args: string } | null {
  // Windows Installer products are removed through msiexec, like "Programs and Features" does.
  if (app.WindowsInstaller === 1 && MSI_PRODUCT.test(app.Key)) return { file: 'msiexec.exe', args: `/x ${app.Key}` };
  return app.UninstallString ? parseCommandLine(app.UninstallString) : null;
}

function isListed(app: RegistryApp): boolean {
  if (!app.DisplayName?.trim()) return false;
  if (app.SystemComponent === 1) return false;
  if (app.ParentKeyName) return false;
  if (app.ReleaseType && /update|hotfix/i.test(app.ReleaseType)) return false;
  return Boolean(app.UninstallString) || app.WindowsInstaller === 1;
}

function formatInstallDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(6, 8)}/${value.slice(4, 6)}/${value.slice(0, 4)}`;
}

export class AppsService {
  private cache = new Map<string, RegistryApp>();

  async list(): Promise<InstalledApp[]> {
    const output = await runPowerShell(LIST_SCRIPT);
    const parsed = JSON.parse(output.trim() || '[]') as RegistryApp[] | RegistryApp;
    const raw = Array.isArray(parsed) ? parsed : [parsed];
    const byName = new Map<string, { app: InstalledApp; source: RegistryApp }>();
    this.cache.clear();
    for (const source of raw) {
      if (!isListed(source)) continue;
      const id = `${source.Hive}\\${source.Key}`;
      const app: InstalledApp = {
        id,
        name: source.DisplayName!.trim(),
        publisher: source.Publisher?.trim() ?? '',
        version: source.DisplayVersion?.trim() ?? '',
        size: typeof source.EstimatedSize === 'number' && source.EstimatedSize > 0 ? source.EstimatedSize * 1024 : null,
        installDate: formatInstallDate(source.InstallDate),
        canUninstall: source.NoRemove !== 1 && uninstallCommand(source) !== null,
      };
      // The same product often appears in more than one hive; keep one entry.
      const key = `${app.name}|${app.version}`.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, { app, source });
        this.cache.set(id, source);
      }
    }
    return [...byName.values()].map(({ app }) => app).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  /** Opens the app's own uninstaller. The id must come from the last list; the renderer never sends commands. */
  async uninstall(appId: string): Promise<UninstallResult> {
    if (!this.cache.has(appId)) await this.list();
    const source = this.cache.get(appId);
    if (!source) return { launched: false, message: 'Aplicativo não encontrado. Atualize a lista.' };
    if (source.NoRemove === 1) return { launched: false, message: 'Este aplicativo não permite desinstalação por aqui.' };
    const command = uninstallCommand(source);
    if (!command) return { launched: false, message: 'O aplicativo não registrou um desinstalador.' };
    try {
      await runPowerShell(LAUNCH_SCRIPT, { LIMPAC_UNINSTALL_FILE: command.file, LIMPAC_UNINSTALL_ARGS: command.args });
      return {
        launched: true,
        message: `O desinstalador de ${source.DisplayName} foi aberto. Siga as instruções dele para concluir.`,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(text)) return { launched: false, message: 'A desinstalação foi cancelada.' };
      return { launched: false, message: `Não foi possível abrir o desinstalador: ${text.split('\n')[0]}` };
    }
  }
}
