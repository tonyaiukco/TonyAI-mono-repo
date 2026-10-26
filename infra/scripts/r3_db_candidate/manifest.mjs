// Private offline preparation (db-candidate02). Exact source manifest validation: flat file name -> sha256.
// Pure: file bytes come from an injected reader; no filesystem, network or CLI access here.
import { createHash } from 'node:crypto';

export const MANIFEST_LIMITS = Object.freeze({ files: 64, fileBytes: 16 * 1024 * 1024 });
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;

export class ManifestRefusal extends Error {
  constructor(code, problems = []) { super(code); this.name = 'ManifestRefusal'; this.code = code; this.problems = Object.freeze([...problems]); }
}
const refuse = (code, problems) => { throw new ManifestRefusal(code, problems); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function requireManifest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) refuse('MANIFEST_SHAPE');
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
  if (names.length < 1 || names.length > MANIFEST_LIMITS.files) refuse('MANIFEST_SIZE');
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!('value' in descriptor) || !descriptor.enumerable) refuse('MANIFEST_SHAPE');
    if (!NAME.test(name) || name.includes('..')) refuse('MANIFEST_NAME', [name]);
    if (typeof descriptor.value !== 'string' || !HEX.test(descriptor.value)) refuse('MANIFEST_DIGEST', [name]);
  }
  return Object.freeze(Object.fromEntries(names.sort().map(name => [name, descriptors[name].value])));
}

export function canonicalManifest(manifest) {
  return JSON.stringify(requireManifest(manifest)) + '\n';
}
export function manifestSha256(manifest) { return sha(canonicalManifest(manifest)); }

// Only the canonical byte form is accepted, which also excludes duplicate keys, BOMs and reordering.
export function parseCanonicalManifest(text) {
  if (typeof text !== 'string') refuse('MANIFEST_TEXT');
  let parsed;
  try { parsed = JSON.parse(text); } catch { refuse('MANIFEST_TEXT'); }
  const manifest = requireManifest(parsed);
  if (canonicalManifest(manifest) !== text) refuse('MANIFEST_NONCANONICAL');
  return manifest;
}

export function compareManifest(expected, observed) {
  const want = requireManifest(expected), have = requireManifest(observed);
  const problems = [];
  for (const name of Object.keys(want)) {
    if (!Object.hasOwn(have, name)) problems.push('MISSING:' + name);
    else if (have[name] !== want[name]) problems.push('MISMATCH:' + name);
  }
  for (const name of Object.keys(have)) if (!Object.hasOwn(want, name)) problems.push('EXTRA:' + name);
  if (problems.length) refuse('MANIFEST_MISMATCH', problems.sort());
  return Object.freeze({ status: 'MANIFEST_MATCH', manifest_sha256: manifestSha256(want), files: Object.keys(want).length });
}

// readBytes(name) must return the exact bytes (Uint8Array) of a pre-enumerated flat file; it is never given a path.
export function observeManifest(names, readBytes) {
  if (!Array.isArray(names) || typeof readBytes !== 'function') refuse('OBSERVE_INPUT');
  if (new Set(names).size !== names.length) refuse('OBSERVE_DUPLICATE');
  const result = {};
  for (const name of [...names].sort()) {
    if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) refuse('MANIFEST_NAME', [String(name)]);
    let bytes;
    try { bytes = readBytes(name); } catch { refuse('OBSERVE_READ', [name]); }
    if (!(bytes instanceof Uint8Array)) refuse('OBSERVE_BYTES', [name]);
    if (bytes.byteLength > MANIFEST_LIMITS.fileBytes) refuse('OBSERVE_SIZE', [name]);
    result[name] = sha(bytes);
  }
  return requireManifest(result);
}
