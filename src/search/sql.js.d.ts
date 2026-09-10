/**
 * sql.js ships no type declarations. Rather than pull in @types/sql.js for
 * six method signatures, this ambient module reuses the hand-written types
 * in ./sqljs.ts so `import initSqlJs from "sql.js"` typechecks.
 */
declare module "sql.js" {
  import type { InitSqlJs } from "./sqljs";

  const initSqlJs: InitSqlJs;
  export default initSqlJs;
}
