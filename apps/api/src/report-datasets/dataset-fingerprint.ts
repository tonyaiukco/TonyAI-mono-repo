import { createHash } from 'node:crypto';
import type { ReportDataset, ReportDatasetFingerprint } from '@tonyai/shared-types';

/**
 * The dataset's content fingerprint, version `tonyai-report-dataset-v1`
 * (README, "Fingerprint encoding"; LP3-04 PR C). The whole dataset but its
 * `datasetId`, `capturedAt` and `fingerprint` is canonicalised and hashed with
 * SHA-256, so two captures of the same facts share a fingerprint and a changed
 * fact never does.
 *
 * Canonical JSON accepts null, booleans, strings, finite numbers, dense arrays
 * and plain or null-prototype objects only — anything else is refused, never
 * coerced: a Date, Decimal, Buffer or class instance, an accessor, a symbol or
 * non-enumerable property, a custom `toJSON`, a present `undefined`, a hole or
 * an extra array property. Object keys sort by UTF-16 code units; every array
 * is a semantic set, so its members' canonical strings sort the same way and
 * keep their multiplicity. Strings are never Unicode-normalised and numbers
 * never rounded; -0 is 0.
 */
export const REPORT_DATASET_CANONICALIZATION = 'tonyai-report-dataset-v1' as const;

/** The top-level members that identify a capture rather than its content. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['datasetId', 'capturedAt', 'fingerprint']);

export class CanonicalJsonError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = 'CanonicalJsonError';
  }
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical spelling of `value` under `tonyai-report-dataset-v1`. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', []);
}

function encode(value: unknown, path: string, ancestors: object[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, 'a non-finite number');
      // JSON.stringify spells -0 as 0, as the encoding requires.
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(path, `a ${typeof value} is not JSON`);
  }
  if (ancestors.includes(value)) throw new CanonicalJsonError(path, 'a cycle');
  ancestors.push(value);
  try {
    return Array.isArray(value) ? encodeArray(value, path, ancestors) : encodeObject(value, path, ancestors);
  } finally {
    ancestors.pop();
  }
}

function encodeArray(array: unknown[], path: string, ancestors: object[]): string {
  if (Object.getPrototypeOf(array) !== Array.prototype) throw new CanonicalJsonError(path, 'not a plain array');
  if (Object.getOwnPropertySymbols(array).length > 0) throw new CanonicalJsonError(path, 'a symbol property');
  // Every index present (no hole) and nothing but the indices and `length`.
  if (Object.getOwnPropertyNames(array).length !== array.length + 1) {
    throw new CanonicalJsonError(path, 'a hole or a property other than its elements');
  }
  const members: string[] = [];
  for (let i = 0; i < array.length; i += 1) {
    const at = `${path}[${i}]`;
    const member = dataValue(array, String(i), at);
    members.push(encode(member, at, ancestors));
  }
  members.sort(byCodeUnits);
  return `[${members.join(',')}]`;
}

function encodeObject(object: object, path: string, ancestors: object[], omit?: ReadonlySet<string>): string {
  const prototype: unknown = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(path, 'not a plain object (a Date, Decimal, Buffer or class instance)');
  }
  if (Object.getOwnPropertySymbols(object).length > 0) throw new CanonicalJsonError(path, 'a symbol property');
  if (typeof (object as { toJSON?: unknown }).toJSON === 'function') {
    throw new CanonicalJsonError(path, 'a custom toJSON');
  }
  const members: Array<[string, string]> = [];
  for (const key of Object.getOwnPropertyNames(object)) {
    if (omit?.has(key)) continue;
    const at = `${path}.${key}`;
    members.push([key, encode(dataValue(object, key, at), at, ancestors)]);
  }
  members.sort(([a], [b]) => byCodeUnits(a, b));
  return `{${members.map(([key, json]) => `${JSON.stringify(key)}:${json}`).join(',')}}`;
}

/** An own, enumerable data property's value; a present `undefined` is refused. */
function dataValue(holder: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (descriptor === undefined) throw new CanonicalJsonError(path, 'a hole');
  if (!('value' in descriptor)) throw new CanonicalJsonError(path, 'an accessor');
  if (descriptor.enumerable !== true) throw new CanonicalJsonError(path, 'a non-enumerable property');
  if (descriptor.value === undefined) throw new CanonicalJsonError(path, 'undefined (omit the key instead)');
  return descriptor.value;
}

/**
 * The canonical content a dataset's fingerprint hashes: the whole dataset but
 * its identity members, after its identity rules hold (`assertDatasetIdentities`).
 */
export function canonicalDatasetContent(dataset: Omit<ReportDataset, 'fingerprint'> | ReportDataset): string {
  assertDatasetIdentities(dataset);
  return encodeObject(dataset, '$', [dataset], IDENTITY_KEYS);
}

export function reportDatasetFingerprint(
  dataset: Omit<ReportDataset, 'fingerprint'> | ReportDataset,
): ReportDatasetFingerprint {
  const hex = createHash('sha256').update(canonicalDatasetContent(dataset), 'utf8').digest('hex');
  return { algorithm: 'sha256', canonicalization: REPORT_DATASET_CANONICALIZATION, hex };
}

/**
 * The encoding's identity rules (README): IDs unique within each named
 * collection — records, evidence, releases, sources; boundary subsidiaries,
 * entity keys `(subsidiaryId, locationId)`, attribution keys
 * `(subsidiaryId, category)` and applicability keys
 * `(subsidiaryId, locationId, category)` unique; obligation IDs unique across
 * the whole boundary; and every reference list — a member named `…Ids` — a
 * set. A calculation snapshot is retained unchanged and is not searched.
 */
export function assertDatasetIdentities(dataset: Omit<ReportDataset, 'fingerprint'> | ReportDataset): void {
  const { boundary } = dataset;
  unique('$.records', dataset.records.map((r) => r.id));
  unique('$.evidence', dataset.evidence.map((e) => e.id));
  unique('$.provenance.releases', dataset.provenance.releases.map((r) => r.id));
  unique('$.boundary.sources', boundary.sources.map((s) => s.id));
  unique('$.boundary.entities', boundary.entities.map((e) => key(e.subsidiaryId, e.locationId)));
  unique('$.boundary.attribution', boundary.attribution.map((p) => key(p.subsidiaryId, p.category)));
  unique('$.boundary.applicability', boundary.applicability.map((c) => key(c.subsidiaryId, c.locationId, c.category)));
  unique('$.boundary.sources[].obligations', boundary.sources.flatMap((s) => (s.obligations ?? []).map((o) => o.id)));
  referenceSets(dataset, '$');
}

const key = (...parts: Array<string | null>): string => JSON.stringify(parts);

function unique(path: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new CanonicalJsonError(path, `a duplicate identity ${id}`);
    seen.add(id);
  }
}

function referenceSets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((member, i) => referenceSets(member, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [name, member] of Object.entries(value)) {
    // A record's calculation is retained as its producer wrote it.
    if (name === 'calculation' && /^\$\.records\[\d+\]$/.test(path)) continue;
    if (name.endsWith('Ids') && Array.isArray(member)) unique(`${path}.${name}`, member as string[]);
    referenceSets(member, `${path}.${name}`);
  }
}
