import type {
  AuthUser,
  CreateSubsidiaryInput,
  DashboardKpi,
  SubsidiaryDTO,
  UpdateSubsidiaryInput,
} from "@tonyai/shared-types";
import { getSupabaseBrowserClient } from "./supabase";

const BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api/v1";

async function authHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
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
    throw new Error(Array.isArray(message) ? message.join(", ") : message);
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
};
