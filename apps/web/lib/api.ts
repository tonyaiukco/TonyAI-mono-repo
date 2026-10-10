import type {
  ActivityRecordDTO,
  ApiErrorCode,
  ApiErrorParams,
  AuditLogDTO,
  AuthUser,
  ListAuditParams,
  ListActivityRecordsParams,
  ActivityRecordPageParams,
  ActivityRecordPageFilters,
  ActivityRecordPageItemDTO,
  ActivityRecordListMetadataDTO,
  CursorPage,
  CursorPageParams,
  PeriodLockPageParams,
  TargetPageParams,
  TargetProgressParams,
  DenominatorPageParams,
  Paginated,
  ActivityCalculationSnapshot,
  CalculationInput,
  CreateActivityRecordInput,
  CreateDenominatorInput,
  CreateLocationInput,
  CreatePeriodLockInput,
  CreateSubsidiaryInput,
  CreateTargetInput,
  DashboardKpi,
  DenominatorDTO,
  EvidenceDTO,
  EvidenceDetachDTO,
  EvidenceUrlDTO,
  ImportBatchDetailDTO,
  ImportBatchDTO,
  IntensityResponseDTO,
  LocationDTO,
  PeriodLockDTO,
  EmissionsSummary,
  EmissionsSummaryParams,
  ReportingContext,
  ReportingContextResponse,
  ReportingExportParams,
  ReportingIntensityData,
  ReportExportType,
  ReportMetaDTO,
  ReportParams,
  TargetDTO,
  TargetProgressDTO,
  SubsidiaryCompletenessDTO,
  TrackingMatrixDTO,
  RejectInput,
  VoidInput,
  SubsidiaryDTO,
  SubsidiarySummaryDTO,
  UpdateActivityRecordInput,
  UpdateDenominatorInput,
  UpdateLocationInput,
  UpdateSubsidiaryInput,
  UpdateTargetInput,
  BulkUploadReportDTO,
  BulkSubmitReportDTO,
  UpdatePreferencesRequest,
} from "@tonyai/shared-types";
import {
  DEFAULT_PAGE_LIMIT, TARGET_PROGRESS_MAX_IDS, isApiErrorCode, isCursorPage,
  REPORTING_CONTEXT_API_PATHS, REPORTING_CONTEXT_KEYS, GROUP_INTENSITY_METRICS,
  isReportingContext, matchesReportingContext,
} from "@tonyai/shared-types";
import { getSupabaseBrowserClient } from "./supabase";

// Preserve the old import path; shared-types is the canonical definition.
export type { EmissionsSummaryParams } from "@tonyai/shared-types";

const BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api/v1";

async function authHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * What a screen says when the API answers 401: the session ended. The pages
 * that already handled it all used this sentence; it lives here so a new
 * error mapper cannot fall through to the raw "Unauthorized".
 */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired — please sign in again.';

/**
 * Error thrown by the API client. A screen branches on `code` (LP3-01's
 * registry in `@tonyai/shared-types`) and words it through the catalogue —
 * `describeApiError` in `lib/i18n/errors.ts` — never on `message`, the
 * server's English sentence, which is kept for logs and the K5 fallback.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Absent when the body had none this build knows: a proxy's non-JSON
     *  413, or a code from an API newer than this page. */
    readonly code?: ApiErrorCode,
    readonly params?: ApiErrorParams,
    /** Raw Retry-After value on a 429, if exposed by the API/proxy. PR B exposes
     * it through CORS. No automatic batch retry is implied. */
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Serialize LP4-05's additive contracts without broadening a query: null site
 * means company-level, an empty cursor/targetIds is sent for the API to refuse,
 * and only the documented empty status set means no filter. */
const PAGE_KEYS = ["limit", "cursor"] as const satisfies readonly (keyof CursorPageParams)[];
const ACTIVITY_FILTER_KEYS = ["subsidiaryId", "year", "period", "category", "status", "locationId", "periodValue", "scope", "search"] as const satisfies readonly (keyof ActivityRecordPageFilters)[];
const ACTIVITY_PAGE_KEYS = [...PAGE_KEYS, ...ACTIVITY_FILTER_KEYS, "sort"] as const satisfies readonly (keyof ActivityRecordPageParams)[];
const PERIOD_LOCK_PAGE_KEYS = [...PAGE_KEYS, "subsidiaryId", "year", "period", "periodValue"] as const satisfies readonly (keyof PeriodLockPageParams)[];
const TARGET_PAGE_KEYS = [...PAGE_KEYS, "subsidiaryId"] as const satisfies readonly (keyof TargetPageParams)[];
const TARGET_PROGRESS_KEYS = ["targetIds"] as const satisfies readonly (keyof TargetProgressParams)[];
const DENOMINATOR_PAGE_KEYS = [...PAGE_KEYS, "subsidiaryId", "year"] as const satisfies readonly (keyof DenominatorPageParams)[];

// `satisfies` rejects unknown keys, but optional fields can still be omitted.
// Fail compilation if any endpoint forgets a key, including a future filter.
const _noMissingQueryKeys: never = null as unknown as (
  | Exclude<keyof CursorPageParams, (typeof PAGE_KEYS)[number]>
  | Exclude<keyof ActivityRecordPageFilters, (typeof ACTIVITY_FILTER_KEYS)[number]>
  | Exclude<keyof ActivityRecordPageParams, (typeof ACTIVITY_PAGE_KEYS)[number]>
  | Exclude<keyof PeriodLockPageParams, (typeof PERIOD_LOCK_PAGE_KEYS)[number]>
  | Exclude<keyof TargetPageParams, (typeof TARGET_PAGE_KEYS)[number]>
  | Exclude<keyof TargetProgressParams, (typeof TARGET_PROGRESS_KEYS)[number]>
  | Exclude<keyof DenominatorPageParams, (typeof DENOMINATOR_PAGE_KEYS)[number]>
);
void _noMissingQueryKeys;

function boundedQuery(params: object, keys: readonly string[]): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!keys.includes(key)) continue;
    if (value === undefined || (key === "status" && Array.isArray(value) && !value.length)) continue;
    if (value === null && key !== "locationId") {
      throw new ApiError("Invalid query parameter.", 400, "validation_failed");
    }
    search.set(key, value === null ? "none" : Array.isArray(value) ? value.join(",") : String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** PR A publishes unused methods; PR C changes their routes to one page shape.
 * Calling one against the old API fails explicitly instead of accepting an
 * unbounded array. This checks the envelope, not each domain DTO. */
async function apiCursorPage<T>(path: string, params: CursorPageParams, keys: readonly string[] = PAGE_KEYS): Promise<CursorPage<T>> {
  const result = await apiFetch<unknown>(`${path}${boundedQuery(params, keys)}`);
  if (!isCursorPage(result) || result.limit !== (params.limit ?? DEFAULT_PAGE_LIMIT) ||
      (result.nextCursor !== null && result.nextCursor === params.cursor)) {
    throw new ApiError("The server returned an incompatible page response.", 502, "internal_error");
  }
  return result as CursorPage<T>;
}

/** Only plain string or finite-number values survive — a param is rendered
 *  into a sentence, so nothing else from a response body may reach one. */
function errorParams(raw: unknown): ApiErrorParams | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      params[key] = value;
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Turn a failed response into an `ApiError` carrying the server's own sentence.
 *
 * Extracted because there were three byte-identical copies — in `apiFetch`, in
 * `uploadEvidence` and in `downloadReport` — and the two multipart/blob calls
 * this file gains next would have made five. The duplication exists at all
 * because `apiFetch` sets `Content-Type: application/json` unconditionally,
 * which suppresses the browser's multipart boundary, so a file upload cannot
 * go through the wrapper.
 *
 * RETURNS the error rather than throwing it, so every call site reads
 * `throw await apiError(res)`. A helper that throws is one a caller can
 * `await` without `throw` — or call without `await` — and both compile clean,
 * because `no-floating-promises` is deliberately off in this repo.
 */
export async function apiError(res: Response): Promise<ApiError> {
  let message: string | string[] = `API ${res.status}`;
  let code: ApiErrorCode | undefined;
  let params: ApiErrorParams | undefined;
  try {
    const body = await res.json();
    message = body?.message ?? message;
    code = isApiErrorCode(body?.code) ? body.code : undefined;
    params = errorParams(body?.params);
  } catch {
    /* a 413 from the proxy, or any non-JSON body — keep the status sentence */
  }
  return new ApiError(
    Array.isArray(message) ? message.join(", ") : String(message),
    res.status,
    code,
    params,
    res.status === 429 ? res.headers.get("Retry-After") ?? undefined : undefined,
  );
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) throw await apiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Pick only inventory keys from a wider view/export configuration. Never
 * coerce an invalid/empty selection into an unfiltered request. */
function reportingContext(params: ReportingContext): ReportingContext {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new ApiError("Invalid reporting context.", 400, "validation_failed");
  }
  const context = Object.fromEntries(REPORTING_CONTEXT_KEYS.map((key) => [key, params[key]]));
  if (!isReportingContext(context)) {
    throw new ApiError("Invalid reporting context.", 400, "validation_failed");
  }
  return context;
}

async function apiReporting<T>(path: string, params: ReportingContext): Promise<ReportingContextResponse<T>> {
  // Capture before awaiting auth/network: a caller changing its object cannot
  // change the context against which this response is checked.
  const context = reportingContext(params);
  const result = await apiFetch<ReportingContextResponse<T>>(`${path}${boundedQuery(context, REPORTING_CONTEXT_KEYS)}`);
  if (!result || !matchesReportingContext(result.context, context) || result.data === undefined || result.data === null) {
    throw new ApiError("The server returned an incompatible reporting context.", 502, "internal_error");
  }
  return result;
}

/** Verify coverage and D14 at the new client boundary too. This validates the
 * envelope and coverage, not the server's emissions arithmetic. */
function validReportingIntensity(data: ReportingIntensityData, context: ReportingContext): boolean {
  if (!Array.isArray(data.selectedSubsidiaryIds) || !Array.isArray(data.metrics)) return false;
  const ids = data.selectedSubsidiaryIds;
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) return false;
  if (context.subsidiaryId !== undefined && ids.some((id) => id !== context.subsidiaryId)) return false;
  return data.metrics.every((metric) => metric &&
    (context.subsidiaryId !== undefined || (GROUP_INTENSITY_METRICS as readonly string[]).includes(metric.metric)) &&
    Array.isArray(metric.contributingSubsidiaryIds) && metric.contributingSubsidiaryIds.length > 0 &&
    new Set(metric.contributingSubsidiaryIds).size === metric.contributingSubsidiaryIds.length &&
    metric.contributingSubsidiaryIds.every((id) => ids.includes(id)));
}

/** No legacy-route fallback: a pre-LP3-02 API must refuse the new request. */
async function downloadReportingReport(kind: ReportExportType, params: ReportingExportParams): Promise<void> {
  const context = reportingContext(params);
  const query = boundedQuery({ ...context, template: params.template,
    includeMethodologyNotes: params.includeMethodologyNotes, includeEvidenceSummary: params.includeEvidenceSummary,
  }, [...REPORTING_CONTEXT_KEYS, "template", "includeMethodologyNotes", "includeEvidenceSummary"]);
  const res = await fetch(`${BASE_URL}${REPORTING_CONTEXT_API_PATHS[kind]}${query}`, { headers: await authHeaders() });
  if (!res.ok) throw await apiError(res);
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ??
    `tonyai-report-${context.year}.${kind === "excel" ? "xlsx" : kind}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const api = {
  // LP3-02 PR A: dormant until the context routes land. Legacy consumers below
  // remain unchanged; the implementation PR moves annual screens together.
  reportingSummary: (params: ReportingContext) =>
    apiReporting<EmissionsSummary>(REPORTING_CONTEXT_API_PATHS.summary, params),
  reportingMatrix: (params: ReportingContext) =>
    apiReporting<TrackingMatrixDTO>(REPORTING_CONTEXT_API_PATHS.matrix, params),
  reportingMeta: async (params: ReportingContext) => {
    const result = await apiReporting<ReportMetaDTO>(REPORTING_CONTEXT_API_PATHS.meta, params);
    if (result.data.recordLimit !== undefined &&
        (!Number.isSafeInteger(result.data.recordLimit) || result.data.recordLimit < 1)) {
      throw new ApiError("The server returned an incompatible report limit.", 502, "internal_error");
    }
    return result;
  },
  reportingIntensity: async (params: ReportingContext) => {
    const result = await apiReporting<ReportingIntensityData>(REPORTING_CONTEXT_API_PATHS.intensity, params);
    if (!validReportingIntensity(result.data, result.context)) {
      throw new ApiError("The server returned incompatible intensity coverage.", 502, "internal_error");
    }
    return result;
  },
  downloadReportingReport,
  me: () => apiFetch<AuthUser>("/me"),
  /** The caller's own preferences (today the UI language); answers the updated user. */
  updateMyPreferences: (body: UpdatePreferencesRequest) =>
    apiFetch<AuthUser>("/me/preferences", { method: "PATCH", body: JSON.stringify(body) }),
  listSubsidiaries: () => apiFetch<SubsidiaryDTO[]>("/subsidiaries"),
  getSubsidiary: (id: string) => apiFetch<SubsidiaryDTO>(`/subsidiaries/${id}`),
  /** Counts of everything hanging off a subsidiary, plus why a delete would be
   *  refused — the guard's own sentences, so the panel never restates them. */
  getSubsidiarySummary: (id: string) =>
    apiFetch<SubsidiarySummaryDTO>(`/subsidiaries/${id}/summary`),
  createSubsidiary: (body: CreateSubsidiaryInput) =>
    apiFetch<SubsidiaryDTO>("/subsidiaries", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSubsidiary: (id: string, body: UpdateSubsidiaryInput) =>
    apiFetch<SubsidiaryDTO>(`/subsidiaries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSubsidiary: (id: string) =>
    apiFetch<{ id: string; deleted: true }>(`/subsidiaries/${id}`, {
      method: "DELETE",
    }),
  kpi: () => apiFetch<DashboardKpi>("/kpi"),

  // --- Operational locations ---
  listLocations: (subsidiaryId?: string) =>
    apiFetch<LocationDTO[]>(
      `/locations${subsidiaryId ? `?subsidiaryId=${encodeURIComponent(subsidiaryId)}` : ""}`,
    ),
  createLocation: (body: CreateLocationInput) =>
    apiFetch<LocationDTO>("/locations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateLocation: (id: string, body: UpdateLocationInput) =>
    apiFetch<LocationDTO>(`/locations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteLocation: (id: string) =>
    apiFetch<{ id: string; deleted: true }>(`/locations/${id}`, {
      method: "DELETE",
    }),

  // --- Calculation engine ---
  previewCalculation: (input: CalculationInput) =>
    // Union, not CalculationResult: the preview mirrors what would be stored,
    // and an invoice-tracked category with no factor previews as the explicit
    // "not calculated" shape. Typed narrowly this compiled fine and lied.
    apiFetch<ActivityCalculationSnapshot>("/calculations/preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // --- Activity records ---
  /** @deprecated PR C migrates every active consumer to listActivityRecordPage.
   * Retained only so the standalone contract PR works with the current API. */
  listActivityRecords: (params: ListActivityRecordsParams = {}) => {
    const search = new URLSearchParams();
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    if (params.year !== undefined) search.set("year", String(params.year));
    if (params.period) search.set("period", params.period);
    if (params.category) search.set("category", params.category);
    // A set becomes the comma-separated form the API's DTO parses back.
    // `?.length`, not truthiness: `[]` is truthy and would serialise to
    // `status=`, which the DTO deliberately rejects — an unchecked "filter by
    // status" checkbox group would 400 instead of returning everything.
    if (params.status?.length) search.set("status", params.status.join(","));
    const qs = search.toString();
    return apiFetch<ActivityRecordDTO[]>(
      `/activity-records${qs ? `?${qs}` : ""}`,
    );
  },
  /** Requires LP4-05 PR C's API. Never automatically drains later pages. */
  listActivityRecordPage: (params: ActivityRecordPageParams = {}) =>
    apiCursorPage<ActivityRecordPageItemDTO>("/activity-records", params, ACTIVITY_PAGE_KEYS),
  /** The same scoped filters as the list, without cursor/order. Requires PR C. */
  activityRecordMetadata: (params: ActivityRecordPageFilters = {}) =>
    apiFetch<ActivityRecordListMetadataDTO>(`/activity-records/metadata${boundedQuery(params, ACTIVITY_FILTER_KEYS)}`),
  getActivityRecord: (id: string) =>
    apiFetch<ActivityRecordDTO>(`/activity-records/${id}`),
  createActivityRecord: (body: CreateActivityRecordInput) =>
    apiFetch<ActivityRecordDTO>("/activity-records", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateActivityRecord: (id: string, body: UpdateActivityRecordInput) =>
    apiFetch<ActivityRecordDTO>(`/activity-records/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  submitActivityRecord: (id: string) =>
    apiFetch<ActivityRecordDTO>(`/activity-records/${id}/submit`, {
      method: "POST",
    }),

  // The review verbs. Each is a POST with no body except `reject`, which
  // carries the reason the submitter will read. The role rules (consultant may
  // review and reject but not approve) are enforced by the API — the UI hides
  // what a role cannot do, it does not decide it.
  reviewActivityRecord: (id: string) =>
    apiFetch<ActivityRecordDTO>(`/activity-records/${id}/review`, {
      method: "POST",
    }),

  approveActivityRecord: (id: string) =>
    apiFetch<ActivityRecordDTO>(`/activity-records/${id}/approve`, {
      method: "POST",
    }),

  rejectActivityRecord: (id: string, body: RejectInput) =>
    apiFetch<ActivityRecordDTO>(`/activity-records/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Withdraw an approved figure from the inventory (the void path), super_admin only. */
  voidActivityRecord: (id: string, body: VoidInput) =>
    apiFetch<ActivityRecordDTO>(`/activity-records/${id}/void`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // --- Evidence (a file backs one or more records of one subsidiary) ---
  listEvidence: (recordId: string) =>
    apiFetch<EvidenceDTO[]>(`/activity-records/${recordId}/evidence`),
  /** Requires PR C. Files ordered by createdAt DESC, id DESC. Each file's
   * linkedRecords remains complete and bounded by EVIDENCE_MAX_LINKED_RECORDS;
   * a violated stored bound is refused, never silently truncated. */
  listEvidencePage: (recordId: string, params: CursorPageParams = {}) =>
    apiCursorPage<EvidenceDTO>(`/activity-records/${recordId}/evidence`, params),
  uploadEvidence: async (recordId: string, file: File) => {
    // Multipart: let the browser set Content-Type (with boundary), so this
    // bypasses the JSON apiFetch wrapper but keeps the same auth + error shape.
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(
      `${BASE_URL}/activity-records/${recordId}/evidence`,
      { method: "POST", headers: await authHeaders(), body: form },
    );
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as EvidenceDTO;
  },
  /**
   * One file for several records of one subsidiary. All or nothing: a refusal
   * is a 400 whose sentence names every record that could not take it.
   */
  uploadEvidenceForRecords: async (file: File, recordIds: string[]) => {
    const form = new FormData();
    form.append("file", file);
    form.append("recordIds", JSON.stringify(recordIds));
    const res = await fetch(`${BASE_URL}/evidence`, {
      method: "POST",
      headers: await authHeaders(),
      body: form,
    });
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as EvidenceDTO;
  },
  getEvidenceUrl: (id: string) =>
    apiFetch<EvidenceUrlDTO>(`/evidence/${id}/url`),
  /** Take a file off one record; the API deletes it when that was its last. */
  detachEvidence: (recordId: string, evidenceId: string) =>
    apiFetch<EvidenceDetachDTO>(
      `/activity-records/${recordId}/evidence/${evidenceId}`,
      { method: "DELETE" },
    ),

  // --- Period locks (FR §4.2) ---
  /** Audit trail (super_admin only), retaining its offset contract. */
  listAudit: (params: ListAuditParams = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const qs = search.toString();
    return apiFetch<Paginated<AuditLogDTO>>(`/audit${qs ? `?${qs}` : ""}`);
  },
  listPeriodLocks: (params: { subsidiaryId?: string; year?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    if (params.year !== undefined) search.set("year", String(params.year));
    const qs = search.toString();
    return apiFetch<PeriodLockDTO[]>(`/period-locks${qs ? `?${qs}` : ""}`);
  },
  /** Requires PR C. Absence from a general page never proves unlocked state. */
  listPeriodLockPage: (params: PeriodLockPageParams = {}) =>
    apiCursorPage<PeriodLockDTO>("/period-locks", params, PERIOD_LOCK_PAGE_KEYS),
  lockPeriod: (body: CreatePeriodLockInput) =>
    apiFetch<PeriodLockDTO>("/period-locks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  unlockPeriod: (id: string) =>
    apiFetch<{ id: string; deleted: true }>(`/period-locks/${id}`, {
      method: "DELETE",
    }),

  // --- Targets & intensity (WP5) ---
  listTargets: (params: { subsidiaryId?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    const qs = search.toString();
    return apiFetch<TargetDTO[]>(`/targets${qs ? `?${qs}` : ""}`);
  },
  /** Requires PR C. */
  listTargetPage: (params: TargetPageParams = {}) =>
    apiCursorPage<TargetDTO>("/targets", params, TARGET_PAGE_KEYS),
  /** Requires PR C. Fetch progress only for the ids on the visible target page. */
  targetPageProgress: async (params: TargetProgressParams) => {
    const result = await apiFetch<unknown>(`/targets/progress${boundedQuery(params, TARGET_PROGRESS_KEYS)}`);
    const requestedIds = params.targetIds.map((id) => id.toLowerCase());
    let previousIndex = -1;
    if (!Array.isArray(result) || result.length > TARGET_PROGRESS_MAX_IDS || !result.every((row) => {
      if (row === null || typeof row !== "object" || typeof row.targetId !== "string") return false;
      const index = requestedIds.indexOf(row.targetId.toLowerCase());
      if (index <= previousIndex) return false;
      previousIndex = index;
      return true;
    })) {
      throw new ApiError("The server returned incompatible target progress.", 502, "internal_error");
    }
    return result as TargetProgressDTO[];
  },
  targetProgress: (params: { subsidiaryId?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    const qs = search.toString();
    return apiFetch<TargetProgressDTO[]>(`/targets/progress${qs ? `?${qs}` : ""}`);
  },
  createTarget: (body: CreateTargetInput) =>
    apiFetch<TargetDTO>("/targets", { method: "POST", body: JSON.stringify(body) }),
  updateTarget: (id: string, body: UpdateTargetInput) =>
    apiFetch<TargetDTO>(`/targets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTarget: (id: string) =>
    apiFetch<{ id: string; deleted: true }>(`/targets/${id}`, { method: "DELETE" }),

  listDenominators: (params: { subsidiaryId?: string; year?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    if (params.year !== undefined) search.set("year", String(params.year));
    const qs = search.toString();
    return apiFetch<DenominatorDTO[]>(`/denominators${qs ? `?${qs}` : ""}`);
  },
  /** Requires PR C. */
  listDenominatorPage: (params: DenominatorPageParams = {}) =>
    apiCursorPage<DenominatorDTO>("/denominators", params, DENOMINATOR_PAGE_KEYS),
  createDenominator: (body: CreateDenominatorInput) =>
    apiFetch<DenominatorDTO>("/denominators", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateDenominator: (id: string, body: UpdateDenominatorInput) =>
    apiFetch<DenominatorDTO>(`/denominators/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteDenominator: (id: string) =>
    apiFetch<{ id: string; deleted: true }>(`/denominators/${id}`, {
      method: "DELETE",
    }),
  intensity: (params: { year?: number; subsidiaryId?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.year !== undefined) search.set("year", String(params.year));
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    const qs = search.toString();
    return apiFetch<IntensityResponseDTO>(`/intensity${qs ? `?${qs}` : ""}`);
  },

  // --- Reports (WP6, FR §5) ---
  reportMeta: async (params: { year: number; subsidiaryId?: string }) => {
    const search = new URLSearchParams({ year: String(params.year) });
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    const result = await apiFetch<ReportMetaDTO>(`/reports/meta?${search.toString()}`);
    if (result.recordLimit !== undefined && (!Number.isSafeInteger(result.recordLimit) || result.recordLimit < 1)) {
      throw new ApiError("The server returned an incompatible report limit.", 502, "internal_error");
    }
    return result;
  },
  /** Download a generated report artifact and hand it to the browser. */
  downloadReport: async (kind: ReportExportType, params: ReportParams): Promise<void> => {
    const search = new URLSearchParams({
      template: params.template,
      year: String(params.year),
    });
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    if (params.includeMethodologyNotes !== undefined)
      search.set("includeMethodologyNotes", String(params.includeMethodologyNotes));
    if (params.includeEvidenceSummary !== undefined)
      search.set("includeEvidenceSummary", String(params.includeEvidenceSummary));
    const res = await fetch(`${BASE_URL}/reports/${kind}?${search.toString()}`, {
      headers: await authHeaders(),
    });
    if (!res.ok) throw await apiError(res);
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ??
      `tonyai-report.${kind === "excel" ? "xlsx" : kind}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  // --- Bulk upload (WP8) ---

  /**
   * Import activity records from a CSV/XLSX.
   *
   * `dryRun` is REQUIRED by the server and sent as the literal `"true"` or
   * `"false"`: the DTO accepts only those two spellings, and `"yes"`, `"1"` or
   * an omitted field is a 400 — deliberately, because this flag decides
   * whether up to a thousand irreversible audited records are written.
   */
  bulkUploadActivityRecords: async (
    file: File,
    dryRun: boolean,
  ): Promise<BulkUploadReportDTO> => {
    const form = new FormData();
    form.append("file", file);
    form.append("dryRun", dryRun ? "true" : "false");
    const res = await fetch(`${BASE_URL}/bulk-upload/activity-records`, {
      method: "POST",
      headers: await authHeaders(),
      body: form,
    });
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as BulkUploadReportDTO;
  },

  /**
   * Send many imported drafts for review at once.
   *
   * Ids, not a filter: there is no batch id to filter on, and a draft is
   * submittable by any colleague who can see the subsidiary — so a filter
   * would sweep someone else's work-in-progress into review unenumerated.
   */
  bulkSubmitActivityRecords: (recordIds: string[]) =>
    apiFetch<BulkSubmitReportDTO>("/activity-records/bulk-submit", {
      method: "POST",
      body: JSON.stringify({ recordIds }),
    }),

  // --- Import batches (one per applied bulk import) ---
  listImportBatches: (limit = 10) =>
    apiFetch<ImportBatchDTO[]>(`/import-batches?limit=${limit}`),
  getImportBatch: (id: string) => apiFetch<ImportBatchDetailDTO>(`/import-batches/${id}`),
  /** A short-lived signed URL for the file the batch was imported from. */
  getImportBatchSourceUrl: (id: string) =>
    apiFetch<EvidenceUrlDTO>(`/import-batches/${id}/source-url`),
  /** Send for review every draft of the batch the caller may send. */
  submitImportBatch: (id: string) =>
    apiFetch<BulkSubmitReportDTO>(`/import-batches/${id}/submit`, { method: "POST" }),

  /** Download the import template (XLSX), pre-filled with reachable entities. */
  downloadBulkUploadTemplate: async (): Promise<void> => {
    const res = await fetch(`${BASE_URL}/bulk-upload/template`, {
      headers: await authHeaders(),
    });
    if (!res.ok) throw await apiError(res);
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ??
      "tonyai-bulk-upload-template.xlsx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  // --- Emissions analytics ---
  emissionsSummary: (params: EmissionsSummaryParams = {}) => {
    const search = new URLSearchParams();
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    if (params.year !== undefined) search.set("year", String(params.year));
    if (params.scope !== undefined) search.set("scope", String(params.scope));
    if (params.category) search.set("category", params.category);
    const qs = search.toString();
    return apiFetch<EmissionsSummary>(
      `/emissions/summary${qs ? `?${qs}` : ""}`,
    );
  },
  trackingMatrix: (params: { year?: number; subsidiaryId?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.year !== undefined) search.set("year", String(params.year));
    // The server DTO has accepted this since WP17 PR 2; the client simply did
    // not pass it, so a caller wanting one subsidiary had to download the
    // whole matrix.
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    const qs = search.toString();
    return apiFetch<TrackingMatrixDTO>(
      `/emissions/tracking-matrix${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * Which invoice slots are open for one subsidiary and year (WP17 / DASH-3).
   *
   * Both params are required — the invoice rule is twelve months for one year
   * at one subsidiary, and this endpoint has no yes/no fallback to offer.
   */
  completeness: (params: { subsidiaryId: string; year: number }) => {
    const search = new URLSearchParams({
      subsidiaryId: params.subsidiaryId,
      year: String(params.year),
    });
    return apiFetch<SubsidiaryCompletenessDTO>(
      `/emissions/completeness?${search.toString()}`,
    );
  },
};
