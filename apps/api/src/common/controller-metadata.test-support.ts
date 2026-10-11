import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

/** Vitest's esbuild omits design:paramtypes. Compile the actual controller with
 * the API's TypeScript options so a DTO-to-interface regression changes the
 * reflected type used by the real ValidationPipe. Never patch metadata by hand
 * or read dist, which may predate the source (especially during mutation tests).
 * Only trusted repository source executes, with explicitly supplied imports. */
export function controllerModule<T>(source: string, dependencies: Record<string, unknown>): T {
  const configPath = resolve(__dirname, '../../tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const { options, errors } = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, '.');
  if (errors.length) throw new Error('Invalid API compiler options');
  const fileName = source;
  const { outputText } = ts.transpileModule(readFileSync(source, 'utf8'), { fileName, compilerOptions: options });
  const exports = {};
  const requireDependency = (name: string) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unmapped controller dependency: ${name}`);
    return dependencies[name];
  };
  compileFunction(outputText, ['exports', 'require'], { filename: fileName })(exports, requireDependency);
  return exports as T;
}
