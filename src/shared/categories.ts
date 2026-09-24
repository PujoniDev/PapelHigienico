import type { FileCategory } from './types';

const EXTENSIONS: Record<Exclude<FileCategory, 'other'>, string[]> = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'mts', 'vob'],
  image: [
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif', 'raw', 'cr2', 'cr3', 'nef', 'arw',
    'dng', 'orf', 'rw2', 'psd', 'svg', 'avif',
  ],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff', 'alac'],
  document: [
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'rtf', 'csv', 'md', 'epub',
    'pages', 'key', 'numbers',
  ],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab'],
  installer: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle'],
  diskImage: ['iso', 'img', 'vhd', 'vhdx', 'vmdk', 'vdi', 'wim', 'esd', 'qcow2'],
};

const LOOKUP = new Map<string, FileCategory>();
for (const [category, list] of Object.entries(EXTENSIONS)) {
  for (const ext of list) LOOKUP.set(ext, category as FileCategory);
}

export const CATEGORY_ORDER: FileCategory[] = [
  'video',
  'image',
  'audio',
  'document',
  'archive',
  'installer',
  'diskImage',
  'other',
];

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  video: 'Vídeos',
  image: 'Imagens',
  audio: 'Músicas e áudio',
  document: 'Documentos',
  archive: 'Arquivos compactados',
  installer: 'Programas e instaladores',
  diskImage: 'Imagens de disco',
  other: 'Outros',
};

/** Lower-case extension without the dot, or '' when the name has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function categoryOf(name: string): FileCategory {
  return LOOKUP.get(extensionOf(name)) ?? 'other';
}
