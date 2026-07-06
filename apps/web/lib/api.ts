import type {
  ActivityRecordDTO,
  ActivityRecordStatus,
  AuthUser,
  CalculationInput,
  CalculationResult,
  Category,
  CreateActivityRecordInput,
  CreateLocationInput,
  CreateSubsidiaryInput,
  DashboardKpi,
  LocationDTO,
  EmissionsSummary,
  TrackingMatrixDTO,
  ReportingPeriod,
  SubsidiaryDTO,
  UpdateActivityRecordInput,
  UpdateLocationInput,
  UpdateSubsidiaryInput,
} from "@tonyai/shared-types";
import { getSupabaseBrowserClient } from "./supabase";

/** Optional filters for GET /activity-records (all AND-combined). */
export interface ListActivityRecordsParams {
  subsidiaryId?: string;
  year?: number;
  period?: ReportingPeriod;
  category?: Category;
  status?: ActivityRecordStatus;
}

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
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    let message = `API ${res.status}`;
    try {
      const body = await res.json();
      message = body.message ?? message;
    } catch {
      /* ignore */
    }
    throw new ApiError(
      Array.isArray(message) ? message.join(", ") : message,
      res.status,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => apiFetch<AuthUser>("/me"),
  listSubsidiaries: () => apiFetch<SubsidiaryDTO[]>("/subsidiaries"),
  getSubsidiary: (id: string) => apiFetch<SubsidiaryDTO>(`/subsidiaries/${id}`),
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
    apiFetch<CalculationResult>("/calculations/preview", {
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
    if (params.status) search.set("status", params.status);
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
  trackingMatrix: (params: { year?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.year !== undefined) search.set("year", String(params.year));
    const qs = search.toString();
    return apiFetch<TrackingMatrixDTO>(
      `/emissions/tracking-matrix${qs ? `?${qs}` : ""}`,
    );
  },
};
