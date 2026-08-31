/**
 * The slice of sql.js this project uses. The package ships no types, and
 * pulling @types/sql.js would add a dependency for four method signatures.
 *
 * sql.js is reached as a global: the worker calls `importScripts` on the
 * vendored UMD bundle, which defines `initSqlJs` on `self`.
 */

export type SqlValue = number | string | Uint8Array | null;

export interface SqlStatement {
  /** Advances to the next row. False when the result set is exhausted. */
  step(): boolean;
  /** The current row, in the SELECT's column order. */
  get(): SqlValue[];
  free(): void;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface SqlJsStatic {
  Database: new (data: Uint8Array) => SqlDatabase;
}

export type InitSqlJs = (config: { locateFile: (file: string) => string }) => Promise<SqlJsStatic>;
