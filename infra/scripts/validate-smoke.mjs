import { validateSmoke } from './smoke-contract.mjs';
try { validateSmoke(JSON.parse(process.env.SMOKE_TARGET_JSON)); }
catch { process.exitCode = 1; }
