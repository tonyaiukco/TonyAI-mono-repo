import { ApiError } from "@/lib/api";
import {
  API_ERROR_PARAMS,
  CALCULATION_REFUSAL_CODES,
  genericErrorCode,
  isGenericErrorCode,
  type ApiErrorCode,
  type ApiErrorParams,
  type GenericErrorCode,
  type Locale,
} from "@/lib/types";

/**
 * From a failed call to what the screen says (LP3-01). A screen never shows
 * the API's English `message` for a code it knows; it shows the catalogue's
 * sentence for that code, in the user's language.
 *
 * A code that names only the status (`GENERIC_ERROR_STATUS`) means the API
 * has no screen-worded refusal for this case yet — about 60 sentences, coded
 * by LP4-04. Until then (decision K5): in English the server's own sentence,
 * which is more specific than any generic one, exactly as before LP3-01; in
 * another language the generic sentence, with the server's English sentence
 * beneath it so nothing the user needs is lost.
 *
 * Calculation refusals follow the same rule (independent review P3-7): their
 * English sentence names the lookup ("Unit "litres" is not valid for
 * "Electricity". Accepted: kWh, MWh."), which the catalogue cannot until their
 * params carry it (LP3-04/LP4-04). Their code still decides everything else.
 */

/** The slice of a use-intl translator this needs — `createTranslator` and
 *  `useTranslations()` both satisfy it. */
export interface ErrorTranslator {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

export interface ErrorDescription {
  /** The sentence to show (a toast's title). */
  title: string;
  /** The server's English sentence, when it adds something (K5). */
  description?: string;
}

/** Generic codes whose server sentence says more than the catalogue's. A
 *  401, a 429 or a 5xx never does: the catalogue's sentence is the message. */
const SERVER_WORDED: ReadonlySet<GenericErrorCode> = new Set([
  "bad_request",
  "validation_failed",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
]);

/** Specific codes whose English sentence says more than the catalogue's. */
const SERVER_DETAILED: ReadonlySet<ApiErrorCode> = new Set(CALCULATION_REFUSAL_CODES);

/** A body with no JSON message gets this from `api.ts` — not a sentence. */
const STATUS_ONLY = /^API \d{3}$/;

/**
 * Params as the catalogue reads them: a period and a category in the user's
 * language — they arrive canonical. A plain `{year}` argument is printed as
 * given, never grouped (`qa-auditor` F6), so numbers pass through.
 */
export function localiseParams(params: ApiErrorParams | undefined, t: ErrorTranslator): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === "period" && t.has(`periods.values.${value}`)) out[key] = t(`periods.values.${value}`);
    else if (key === "category" && t.has(`categories.${value}`)) out[key] = t(`categories.${value}`);
    else out[key] = value;
  }
  return out;
}

/** The code an error is shown by: its own, else its status's generic one. */
export function displayCode(error: ApiError): ApiErrorCode {
  return error.code ?? genericErrorCode(error.status);
}

export function describeApiError(error: unknown, t: ErrorTranslator, locale: Locale): ErrorDescription {
  if (!(error instanceof ApiError)) {
    // fetch() rejects with a TypeError when the network, CORS or DNS fails.
    return { title: t(error instanceof TypeError ? "errors.network" : "errors.unexpected") };
  }
  const code = displayCode(error);
  if (!isGenericErrorCode(code)) {
    // A param the sentence names that did not arrive (an older API) would
    // render as a broken sentence: the status's generic one is better.
    const complete = (API_ERROR_PARAMS[code] ?? []).every((name) => error.params?.[name] !== undefined);
    if (!complete) return describeApiError(new ApiError(error.message, error.status), t, locale);
    const title = t(`errors.codes.${code}`, localiseParams(error.params, t));
    const detail = SERVER_DETAILED.has(code) && !STATUS_ONLY.test(error.message) ? error.message : undefined;
    if (detail && locale === "en") return { title: detail };
    return { title, ...(detail ? { description: detail } : {}) };
  }
  const key = `errors.codes.${code}`;
  const serverSentence = SERVER_WORDED.has(code) && !STATUS_ONLY.test(error.message) ? error.message : undefined;
  if (serverSentence && locale === "en") return { title: serverSentence };
  return { title: t(key), ...(serverSentence ? { description: serverSentence } : {}) };
}
