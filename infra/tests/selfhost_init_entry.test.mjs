/** Real subprocess entrypoint checks; never replaces the production guard. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = fileURLToPath(new URL('../scripts/selfhost_init.mjs', import.meta.url));
const invoke = (args) => spawnSync(process.execPath, args, {
  encoding: 'utf8', ...(process.getuid() === 0 ? { uid: 65534, gid: 65534 } : {}),
});
test('direct and symlink nonroot entry refuse; plain import has no side effects', () => {
  const folder = mkdtempSync(join(tmpdir(), 'r3-init-'));
  chmodSync(folder, 0o755);
  try {
    // /tmp itself may be a symlink on macOS: exercise both layers.
    const link = join(folder, 'initializer.mjs'); symlinkSync(source, link);
    for (const path of [source, link]) {
      const result = invoke([path]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /FAIL: secret initialization/);
      assert.equal(result.stdout, '');
    }
    const imported = invoke(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/selfhost_init.mjs', import.meta.url).href)});`]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout + imported.stderr, '');
    const output = join(folder, 'generated.env');
    const importedWithArg = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createSettings } from ${JSON.stringify(new URL('../scripts/selfhost_init.mjs', import.meta.url).href)};
      import { writeFileSync } from 'node:fs';
      const settings = createSettings('tonyai-staging-disposable.swedencentral.cloudapp.azure.com', 'qualification@example.invalid');
      writeFileSync(process.argv[1], Object.entries(settings).map(([k,v]) => k+'='+v).join('\\n'), {flag:'wx',mode:0o600});
    `, output], { encoding: 'utf8' });
    assert.equal(importedWithArg.status, 0, importedWithArg.stderr);
    assert.equal(importedWithArg.stdout + importedWithArg.stderr, '');
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally { rmSync(folder, { recursive: true }); }
});
