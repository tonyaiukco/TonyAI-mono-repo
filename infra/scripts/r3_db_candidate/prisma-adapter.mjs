// Private offline preparation. Wraps an already supplied client; never imports or constructs Prisma.
// db-candidate02 amendment of db-candidate01/prisma-adapter.mjs (sha256 f48ef01e8f8d06dda6b330d7c2e757fd535458279d8e67858b89b73e4e1e43b9):
// the exact lane GUC query joins the query allowlist; stimuli remain lane A only.
// A future reviewed entrypoint must authorize and bind source/runtime/credentials before supplying it.
import { SQL, MATRIX, CONTROLS } from './driver.mjs';

const queryStatements = new Set([SQL.identity, SQL.roles, SQL.members, SQL.gucs]);
const executeStatements = new Set([
  SQL.statement, SQL.lock, SQL.timezone, SQL.create, SQL.insert,
  SQL.savepoint, SQL.rollback, SQL.release, ...MATRIX.map(row => row[1]), ...CONTROLS.map(row => row[1]),
]);
const clientObjects = new WeakSet();
const refuse = code => { throw new Error(code); };
const check = (condition, code) => { if (!condition) refuse(code); };

export const wrapCandidatePrisma = (client, lane) => {
  check(client && typeof client === 'object' && ['A', 'B', 'C'].includes(lane), 'ADAPTER_INPUT');
  check(typeof client.$transaction === 'function' && typeof client.$disconnect === 'function', 'CLIENT_SHAPE');
  check(!clientObjects.has(client), 'CLIENT_REUSE');
  clientObjects.add(client);
  let used = false, disconnected = false, transactionRunning = false;
  return Object.freeze({
    interactive: async (callback, options) => {
      check(!used && !disconnected && typeof callback === 'function', 'TRANSACTION_REUSE');
      const timeout = { A: 60000, B: 90000, C: 10000 }[lane];
      check(options && Object.keys(options).sort().join(',') === 'isolationLevel,maxWait,timeout' &&
        options.maxWait === 5000 && options.timeout === timeout && options.isolationLevel === 'ReadCommitted', 'TRANSACTION_OPTIONS');
      used = true; transactionRunning = true;
      let entered = 0, completed = 0;
      try {
        const value = await client.$transaction(async tx => {
          check(transactionRunning && !disconnected && ++entered === 1 && tx && typeof tx.$queryRawUnsafe === 'function' &&
            typeof tx.$executeRawUnsafe === 'function', 'TRANSACTION_CALLBACK');
          let active = true, inFlight = false, violated = false;
          const allow = (condition, code) => { if (!condition) { violated = true; refuse(code); } };
          const call = async (query, statement, parameters) => {
            if (!transactionRunning || disconnected || !active || inFlight || violated) { violated = true; refuse('TRANSACTION_CALL_STATE'); }
            allow((query ? queryStatements : executeStatements).has(statement), 'SQL_NOT_ALLOWED');
            allow(lane === 'A' || ![...MATRIX, ...CONTROLS].some(row => row[1] === statement), 'STIMULUS_LANE');
            allow(statement === SQL.insert
              ? parameters.length === 1 && typeof parameters[0] === 'string' && /^[a-f0-9]{32}$/.test(parameters[0])
              : parameters.length === 0, 'SQL_PARAMETERS');
            inFlight = true;
            try { return await (query ? tx.$queryRawUnsafe(statement, ...parameters) : tx.$executeRawUnsafe(statement, ...parameters)); }
            finally { inFlight = false; }
          };
          const narrow = Object.freeze({
            query: (statement, ...parameters) => call(true, statement, parameters),
            execute: (statement, ...parameters) => call(false, statement, parameters),
          });
          try {
            const result = await callback(narrow);
            check(!inFlight && !violated, 'UNFINISHED_OR_CONCURRENT_CALL');
            completed++;
            return result;
          } finally { active = false; }
        }, { maxWait: 5000, timeout, isolationLevel: 'ReadCommitted' });
        check(entered === 1 && completed === 1, 'MISSING_TRANSACTION_CALLBACK');
        return value;
      } finally { transactionRunning = false; }
    },
    disconnect: async () => {
      check(!transactionRunning && !disconnected, 'DISCONNECT_STATE');
      disconnected = true;
      await client.$disconnect();
    },
  });
};
