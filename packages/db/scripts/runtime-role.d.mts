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
export interface IntegrityTrigger {
  table: string;
  trigger: string;
  fn: string;
  type: number;
}
export declare const INTEGRITY_TRIGGERS: readonly IntegrityTrigger[];
export declare const INTEGRITY_CHECKS: readonly (readonly [table: string, name: string])[];
export declare function expectedTriggerFunctionBodies(dir?: string): Map<string, string>;
export declare function checkIntegrityTriggers(query: Query, expectedBodies?: Map<string, string>): Promise<string[]>;
export declare function factorLibraryReport(query: Query): Promise<{ problems: string[]; notices: string[] }>;
export declare function provisionLocalRuntimeLogin(
  client: { $executeRawUnsafe(sql: string): Promise<unknown> },
  ownerUrl: string,
  password: string,
): Promise<void>;
