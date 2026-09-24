/** Deletion primitives, injected so tests can run without Electron. */
export interface FileRemover {
  /** Sends to the Recycle Bin. Must fail (not delete) when the item cannot be recycled. */
  trash(path: string): Promise<void>;
  /** Deletes a single file permanently. */
  remove(path: string): Promise<void>;
}

export function describeFsError(error: unknown, action: 'trash' | 'remove' | 'copy' | 'read' = 'read'): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'EBUSY':
      return 'O arquivo está em uso por outro programa.';
    case 'EPERM':
    case 'EACCES':
      return 'Sem permissão, ou o arquivo está em uso.';
    case 'ENOENT':
      return 'O arquivo não existe mais.';
    case 'ENOSPC':
      return 'Não há espaço suficiente no disco.';
    case 'EEXIST':
      return 'Já existe um arquivo com esse nome.';
    case 'ENAMETOOLONG':
      return 'O caminho é longo demais.';
    case 'ABORT_ERR':
      return 'Cancelado.';
  }
  if (action === 'trash') {
    return 'Não foi possível enviar para a Lixeira (o arquivo pode estar em uso ou ser grande demais para a Lixeira).';
  }
  return error instanceof Error ? error.message : String(error);
}
