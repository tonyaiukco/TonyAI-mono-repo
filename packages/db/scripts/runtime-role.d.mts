// Types for runtime-role.mjs, imported by the API's integration harness.
type Query = (sql: string) => Promise<Record<string, unknown>[]>;
export declare const RUNTIME_ROLE: 'tonyai_runtime';
export declare function randomRuntimePassword(): string;
export declare function scramVerifier(password: string, salt?: Buffer, iterations?: number): string;
export declare function isLoopbackUrl(url: string): boolean;
export declare function urlUser(url: string): string;
export declare function runtimeUrlFrom(ownerUrl: string, password: string): string;
export declare const RUNTIME_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>>;
export declare const RUNTIME_COLUMN_UPDATES: Readonly<Record<string, readonly string[]>>;
export declare const RUNTIME_STORAGE_PRIVILEGES: Readonly<Record<string, readonly string[]>>;
export declare function checkRuntimeRole(query: Query): Promise<string[]>;
export declare function runtimeRoleExposures(query: Query): Promise<string[]>;
export declare function checkTenantInvariants(query: Query): Promise<string[]>;
export declare function provisionLocalRuntimeLogin(
  client: { $executeRawUnsafe(sql: string): Promise<unknown> },
  ownerUrl: string,
  password: string,
): Promise<void>;
