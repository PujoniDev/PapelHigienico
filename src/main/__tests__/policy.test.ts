import { describe, expect, it } from 'vitest';
import {
  classifyTransferSource,
  isWithin,
  normalizePath,
  protectedReason,
  relativeDestination,
  volumeRootOf,
} from '../policy';
import { fakeKnownPaths } from './helpers';

const known = fakeKnownPaths('C:\\');
const home = known.home; // C:\Users\ana

describe('path helpers', () => {
  it('normalizes long-path prefixes, case of the drive and trailing separators', () => {
    expect(normalizePath('\\\\?\\c:\\Users\\ana\\')).toBe('C:\\Users\\ana');
    expect(normalizePath('C:\\')).toBe('C:\\');
    expect(normalizePath('c:/Users/ana/../ana/Videos')).toBe('C:\\Users\\ana\\Videos');
  });

  it('matches folders on segment boundaries, ignoring case', () => {
    expect(isWithin('C:\\Users\\Ana\\Videos\\a.mp4', 'c:\\users\\ana')).toBe(true);
    expect(isWithin('C:\\Users\\ana2\\a.mp4', 'C:\\Users\\ana')).toBe(false);
    expect(isWithin('C:\\', 'C:\\')).toBe(true);
    expect(isWithin('C:\\Windows', 'C:\\')).toBe(true);
  });

  it('finds the volume root', () => {
    expect(volumeRootOf('d:\\Fotos\\x.jpg')).toBe('D:\\');
  });
});

describe('protected locations', () => {
  it.each([
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'Windows'],
    ['C:\\Program Files\\App\\app.exe', 'programas'],
    ['C:\\Program Files (x86)\\App\\data.bin', 'programas'],
    ['C:\\ProgramData\\Vendor\\cache.db', 'ProgramData'],
    [`${home}\\AppData\\Local\\Google\\Chrome\\x`, 'AppData'],
    ['C:\\$Recycle.Bin\\S-1-5\\file', 'reservada'],
    ['C:\\System Volume Information\\x', 'reservada'],
    ['D:\\Program Files\\Game\\data.pak', 'programas'],
    ['E:\\Windows\\notes.txt', 'sistema'],
  ])('%s is protected', (path, fragment) => {
    expect(protectedReason(path, known)).toContain(fragment);
  });

  it('rejects paths without a drive letter', () => {
    expect(protectedReason('\\\\server\\share\\file.txt', known)).not.toBeNull();
  });

  it('allows ordinary personal folders', () => {
    expect(protectedReason(`${home}\\Videos\\ferias.mp4`, known)).toBeNull();
    expect(protectedReason('D:\\Backup\\ferias.mp4', known)).toBeNull();
  });
});

describe('transfer eligibility', () => {
  it('accepts personal files without warnings', () => {
    const result = classifyTransferSource(`${home}\\Videos\\Viagem\\ferias.mp4`, known);
    expect(result).toMatchObject({ eligible: true, personal: true, synced: false, warnings: [] });
  });

  it.each([
    ['C:\\pagefile.sys', 'sistema'],
    [`${home}\\Documents\\projeto\\node_modules\\x\\big.bin`, 'aplicativo'],
    ['C:\\Games\\SteamLibrary\\steamapps\\common\\x.pak', 'aplicativo'],
    [`${home}\\.vscode\\extensions\\x.vsix`, 'configuração'],
    [`${home}\\Documents\\projeto\\.git\\objects\\pack\\a.pack`, 'configuração'],
    [`${home}\\Documents\\plugin.dll`, 'programa'],
    ['C:\\Windows\\Installer\\x.msi', 'Windows'],
  ])('blocks %s', (path, fragment) => {
    const result = classifyTransferSource(path, known);
    expect(result.eligible).toBe(false);
    expect(result.blockedReason).toContain(fragment);
  });

  it('warns about synchronized folders', () => {
    const result = classifyTransferSource(`${home}\\OneDrive\\Fotos\\a.jpg`, known);
    expect(result.eligible).toBe(true);
    expect(result.synced).toBe(true);
    expect(result.warnings.join(' ')).toContain('OneDrive');
  });

  it('warns about files outside the personal folders', () => {
    expect(classifyTransferSource(`${home}\\projetos\\video.mp4`, known).warnings[0]).toContain('pastas pessoais');
    expect(classifyTransferSource('C:\\Dados\\video.mp4', known).warnings[0]).toContain('pasta do usuário');
  });

  it('warns about Outlook data and virtual disks', () => {
    expect(classifyTransferSource(`${home}\\Documents\\Outlook\\a.pst`, known).warnings.join(' ')).toContain('Outlook');
    expect(classifyTransferSource(`${home}\\Documents\\vm\\disk.vhdx`, known).warnings.join(' ')).toContain('virtual');
  });
});

describe('destination layout', () => {
  it('keeps the path relative to the profile', () => {
    expect(relativeDestination(`${home}\\Videos\\Viagem\\a.mp4`, known)).toBe('Videos\\Viagem\\a.mp4');
  });

  it('prefixes files outside the profile with the drive', () => {
    expect(relativeDestination('C:\\Dados\\a.mp4', known)).toBe('Disco C\\Dados\\a.mp4');
  });
});
