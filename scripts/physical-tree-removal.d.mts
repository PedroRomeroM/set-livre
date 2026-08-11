export type PrivatePhysicalFileReadOptions = {
  allowMissing?: boolean;
  description?: string;
  expectedPosixUserId?: number;
  platform?: NodeJS.Platform;
  readDescriptor?: (descriptor: number) => string;
};

/** @public Runtime implementado pelo módulo ESM homônimo. */
export declare function readPrivatePhysicalFile(
  filePath: string,
  options?: PrivatePhysicalFileReadOptions,
): string | undefined;
