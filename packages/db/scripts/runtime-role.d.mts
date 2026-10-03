// Types for runtime-role.mjs, imported by the API's integration harness.
export declare const RUNTIME_ROLE: 'tonyai_runtime';
export declare const LOCAL_RUNTIME_PASSWORD: string;
export declare function isLoopbackUrl(url: string): boolean;
export declare function urlUser(url: string): string;
export declare function runtimeUrlFrom(ownerUrl: string, password?: string): string;
export declare const RUNTIME_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>>;
export declare const RUNTIME_COLUMN_UPDATES: Readonly<Record<string, readonly string[]>>;
export declare const RUNTIME_STORAGE_PRIVILEGES: Readonly<Record<string, readonly string[]>>;
export declare function checkRuntimeRole(query: (sql: string) => Promise<Record<string, unknown>[]>): Promise<string[]>;
export declare function provisionLocalRuntimeLogin(
  client: { $executeRawUnsafe(sql: string): Promise<unknown> },
  ownerUrl: string,
): Promise<void>;
