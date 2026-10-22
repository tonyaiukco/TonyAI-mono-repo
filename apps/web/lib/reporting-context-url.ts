import {
  CATEGORIES,
  CATEGORY_SCOPE_MAP,
  DEFAULT_REPORTING_YEAR,
  REPORTING_CONTEXT_KEYS,
  isReportingContext,
  isReportingYear,
  type Category,
  type ReportingContext,
} from "@tonyai/shared-types";

/**
 * The reporting context's URL grammar (LP3-02 N1). The URL is authoritative:
 * `?year=2027&subsidiaryId=<id>|all&scope=1|2|3|all&category=<Category>|all`.
 *
 * - Every field is parsed strictly, from its raw text. An empty value, a
 *   repeated key, a leading zero (`02027`, `01`), a malformed id or a wrong-case
 *   category is INVALID — refused, never replaced by remembered state or a
 *   default (`x || undefined` would erase exactly that difference).
 * - `all` is the URL-only clear value of an optional field: it maps to
 *   omission before validation, so a shared link can say "every accessible
 *   subsidiary, unfiltered" and not inherit the recipient's narrowing.
 * - Each field resolves in order: a valid explicit URL value; else its
 *   remembered selection; else the default (DEFAULT_REPORTING_YEAR, all
 *   accessible subsidiaries, unfiltered). Scope and category resolve
 *   TOGETHER: when either appears in the URL (a clear included), both come
 *   from the URL, so a remembered one can neither narrow nor contradict it.
 * - The canonical URL carries all four keys, each once, in a fixed order.
 */

export const REPORTING_CONTEXT_CLEAR = "all";

export type ReportingContextUrlKey = (typeof REPORTING_CONTEXT_KEYS)[number];

/** `undefined` = absent from the URL; `null` = explicitly cleared (`all`). */
export interface ExplicitReportingContext {
  year?: number;
  subsidiaryId?: string | null;
  scope?: 1 | 2 | 3 | null;
  category?: Category | null;
}

export type ReportingContextUrlParse =
  | { ok: true; explicit: ExplicitReportingContext }
  | { ok: false; invalid: ReportingContextUrlKey[] };

/** What `URLSearchParams` and Next's `ReadonlyURLSearchParams` both offer. */
export interface QueryLike {
  getAll(name: string): string[];
  forEach(callback: (value: string, key: string) => void): void;
}

/** The API's id shape (`apps/api/src/common/parse-uuid-param.pipe.ts`):
 * 8-4-4-4-12 hex in either case, which the seed's non-RFC ids satisfy. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A year exactly as typed: digits without a leading zero, inside the range.
 * Data Entry's deep links use the same rule. */
export function parseReportingYearParam(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const year = Number(raw);
  return isReportingYear(year) ? year : null;
}

type Field<T> = { ok: true; value: T | null | undefined } | { ok: false };

function field<T>(params: QueryLike, key: ReportingContextUrlKey, parse: (raw: string) => T | null, clearable: boolean): Field<T> {
  const values = params.getAll(key);
  if (values.length === 0) return { ok: true, value: undefined };
  if (values.length > 1) return { ok: false };
  const [raw] = values;
  if (clearable && raw === REPORTING_CONTEXT_CLEAR) return { ok: true, value: null };
  const value = parse(raw);
  return value === null ? { ok: false } : { ok: true, value };
}

const parseScope = (raw: string): 1 | 2 | 3 | null =>
  raw === "1" ? 1 : raw === "2" ? 2 : raw === "3" ? 3 : null;
const parseCategory = (raw: string): Category | null =>
  (CATEGORIES as readonly string[]).includes(raw) ? (raw as Category) : null;
const parseId = (raw: string): string | null => (ID_SHAPE.test(raw) ? raw : null);

export function parseReportingContextUrl(params: QueryLike): ReportingContextUrlParse {
  const year = field(params, "year", parseReportingYearParam, false);
  const subsidiaryId = field(params, "subsidiaryId", parseId, true);
  const scope = field(params, "scope", parseScope, true);
  const category = field(params, "category", parseCategory, true);
  // A pair the URL states explicitly must agree; a clear agrees with anything.
  const conflict = scope.ok && category.ok && scope.value != null && category.value != null &&
    CATEGORY_SCOPE_MAP[category.value] !== scope.value;
  const invalid: ReportingContextUrlKey[] = [];
  if (!year.ok) invalid.push("year");
  if (!subsidiaryId.ok) invalid.push("subsidiaryId");
  if (!scope.ok || conflict) invalid.push("scope");
  if (!category.ok || conflict) invalid.push("category");
  // Every refused key is named, so one correction fixes the link.
  if (!year.ok || !subsidiaryId.ok || !scope.ok || !category.ok || conflict) return { ok: false, invalid };
  const explicit: ExplicitReportingContext = {};
  if (year.value != null) explicit.year = year.value;
  if (subsidiaryId.value !== undefined) explicit.subsidiaryId = subsidiaryId.value;
  if (scope.value !== undefined) explicit.scope = scope.value;
  if (category.value !== undefined) explicit.category = category.value;
  return { ok: true, explicit };
}

/** Per-field resolution; scope and category as one pair. Returns null when
 * the result is no valid context (only a corrupt remembered value can do it). */
export function resolveReportingContext(
  explicit: ExplicitReportingContext,
  remembered: ReportingContext | null,
): ReportingContext | null {
  const context: ReportingContext = { year: explicit.year ?? remembered?.year ?? DEFAULT_REPORTING_YEAR };
  const subsidiaryId = explicit.subsidiaryId !== undefined ? explicit.subsidiaryId : remembered?.subsidiaryId;
  if (subsidiaryId != null) context.subsidiaryId = subsidiaryId;
  const pairFromUrl = explicit.scope !== undefined || explicit.category !== undefined;
  const scope = pairFromUrl ? explicit.scope : remembered?.scope;
  const category = pairFromUrl ? explicit.category : remembered?.category;
  if (scope != null) context.scope = scope;
  if (category != null) context.category = category;
  return isReportingContext(context) ? context : null;
}

/** The canonical query: all four keys, each once, then the page's own keys in
 * their order. Clears are spelled `all`. */
export function reportingContextQuery(context: ReportingContext, params?: QueryLike): string {
  const query = new URLSearchParams();
  query.set("year", String(context.year));
  query.set("subsidiaryId", context.subsidiaryId ?? REPORTING_CONTEXT_CLEAR);
  query.set("scope", context.scope !== undefined ? String(context.scope) : REPORTING_CONTEXT_CLEAR);
  query.set("category", context.category ?? REPORTING_CONTEXT_CLEAR);
  params?.forEach((value, key) => {
    if (!(REPORTING_CONTEXT_KEYS as readonly string[]).includes(key)) query.append(key, value);
  });
  return query.toString();
}

/** One field changed on the selection bar. `undefined` clears an optional
 * field. A scope that excludes the chosen category clears the category, so the
 * bar can never write a link the parser refuses as a conflict. */
export function nextReportingContext(
  context: ReportingContext,
  patch: Partial<Record<keyof ReportingContext, unknown>>,
): ReportingContext {
  const merged = { ...context, ...patch } as Record<string, unknown>;
  const next: ReportingContext = { year: typeof merged.year === "number" ? merged.year : context.year };
  if (typeof merged.subsidiaryId === "string") next.subsidiaryId = merged.subsidiaryId;
  if (merged.scope === 1 || merged.scope === 2 || merged.scope === 3) next.scope = merged.scope;
  if (typeof merged.category === "string" && (CATEGORIES as readonly string[]).includes(merged.category)) {
    next.category = merged.category as Category;
  }
  if (next.scope !== undefined && next.category !== undefined && CATEGORY_SCOPE_MAP[next.category] !== next.scope) {
    delete next.category;
  }
  return next;
}

/** A stable identity for one context — request guards and effect keys. */
export const reportingContextKey = (context: ReportingContext): string => reportingContextQuery(context);

/** The query string of `params` as it stands (to compare with the canonical one). */
export function queryString(params: QueryLike): string {
  const query = new URLSearchParams();
  params.forEach((value, key) => query.append(key, value));
  return query.toString();
}
