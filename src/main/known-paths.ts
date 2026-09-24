import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePath, type KnownPaths } from './policy';

type PathName = 'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos' | 'music';

/** Resolves Windows known folders. `getPath` is Electron's app.getPath (it follows folder redirection). */
export function resolveKnownPaths(getPath: (name: PathName) => string): KnownPaths {
  const env = process.env;
  const home = normalizePath(homedir());
  const systemDrive = (env.SystemDrive ?? 'C:') + '\\';
  const safe = (name: PathName, fallback: string) => {
    try {
      return normalizePath(getPath(name));
    } catch {
      return normalizePath(join(home, fallback));
    }
  };

  const syncedRoots: KnownPaths['syncedRoots'] = [];
  const addSynced = (label: string, value: string | undefined) => {
    if (!value) return;
    const path = normalizePath(value);
    if (!syncedRoots.some((root) => root.path.toLowerCase() === path.toLowerCase())) syncedRoots.push({ label, path });
  };
  addSynced('OneDrive', env.OneDriveCommercial);
  addSynced('OneDrive', env.OneDriveConsumer);
  addSynced('OneDrive', env.OneDrive);
  for (const name of ['Dropbox', 'Google Drive', 'iCloudDrive']) {
    const candidate = join(home, name);
    if (existsSync(candidate)) addSynced(name, candidate);
  }

  return {
    systemDrive: normalizePath(systemDrive),
    systemRoot: normalizePath(env.SystemRoot ?? env.windir ?? join(systemDrive, 'Windows')),
    programFiles: [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
      .filter((value): value is string => Boolean(value))
      .map(normalizePath),
    programData: normalizePath(env.ProgramData ?? join(systemDrive, 'ProgramData')),
    home,
    appData: normalizePath(env.APPDATA ?? join(home, 'AppData', 'Roaming')),
    localAppData: normalizePath(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')),
    temp: normalizePath(tmpdir()),
    desktop: safe('desktop', 'Desktop'),
    documents: safe('documents', 'Documents'),
    downloads: safe('downloads', 'Downloads'),
    pictures: safe('pictures', 'Pictures'),
    videos: safe('videos', 'Videos'),
    music: safe('music', 'Music'),
    syncedRoots,
  };
}
