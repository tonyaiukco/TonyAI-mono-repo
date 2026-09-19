import type {
  ActivityRecordDTO,
  AuditLogDTO,
  AuthUser,
  ListAuditParams,
  ListActivityRecordsParams,
  Paginated,
  ActivityCalculationSnapshot,
  CalculationInput,
  Category,
  CreateActivityRecordInput,
  CreateDenominatorInput,
  CreateLocationInput,
  CreatePeriodLockInput,
  CreateSubsidiaryInput,
  CreateTargetInput,
  DashboardKpi,
  DenominatorDTO,
  EvidenceDTO,
  EvidenceUrlDTO,
  IntensityResponseDTO,
  LocationDTO,
  PeriodLockDTO,
  EmissionsSummary,
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
} from "@tonyai/shared-types";
import { getSupabaseBrowserClient } from "./supabase";

/** Optional filters for GET /emissions/summary (all AND-combined). */
export interface EmissionsSummaryParams {
  subsidiaryId?: string;
  year?: number;
  scope?: 1 | 2 | 3;
  category?: Category;
}

const BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api/v1";

async function authHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Error thrown by the API client; carries the HTTP status for callers that
 * need to branch on it (e.g. a 404 "no emission factor" preview). */
/**
 * What a screen says when the API answers 401: the session ended. The pages
 * that already handled it all used this sentence; it lives here so a new
 * error mapper cannot fall through to the raw "Unauthorized".
 */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired — please sign in again.';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
async function apiError(res: Response): Promise<ApiError> {
  let message: string | string[] = `API ${res.status}`;
  try {
    const body = await res.json();
    message = body.message ?? message;
  } catch {
    /* a 413 from the proxy, or any non-JSON body — keep the status sentence */
  }
  return new ApiError(
    Array.isArray(message) ? message.join(", ") : message,
    res.status,
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

export const api = {
  me: () => apiFetch<AuthUser>("/me"),
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

  // --- Evidence (files linked to an activity record) ---
  listEvidence: (recordId: string) =>
    apiFetch<EvidenceDTO[]>(`/activity-records/${recordId}/evidence`),
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
  getEvidenceUrl: (id: string) =>
    apiFetch<EvidenceUrlDTO>(`/evidence/${id}/url`),
  deleteEvidence: (id: string) =>
    apiFetch<{ id: string; deleted: true }>(`/evidence/${id}`, {
      method: "DELETE",
    }),

  // --- Period locks (FR §4.2) ---
  /**
   * Audit trail (super_admin only — the API 403s every other role). Paginated:
   * unlike every other list in the app, this one grows without bound.
   */
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
  reportMeta: (params: { year: number; subsidiaryId?: string }) => {
    const search = new URLSearchParams({ year: String(params.year) });
    if (params.subsidiaryId) search.set("subsidiaryId", params.subsidiaryId);
    return apiFetch<ReportMetaDTO>(`/reports/meta?${search.toString()}`);
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
