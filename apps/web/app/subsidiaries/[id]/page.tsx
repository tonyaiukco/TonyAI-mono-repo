"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Building2, Lock, MapPin, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { LocationsPanel } from "@/components/subsidiaries/locations-panel";
import { PeriodLocksDrawer } from "@/components/subsidiaries/period-locks-drawer";
import { geographyLabel, geographyOptions } from "@/lib/types";
import type {
  LocationDTO,
  SubsidiaryDTO,
  SubsidiarySummaryDTO,
} from "@/lib/types";

const STATUSES = ["pending", "active", "inactive"] as const;

const statusClass: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  inactive: "bg-red-500/15 text-red-600 border-red-500/30",
};

/** Branch on the status, the way `/emissions` does. The register page still
 *  does a bare `toast.error(e.message)`, which turns an expired session into a
 *  cryptic 401 string. */
function errMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "Your session has expired — please sign in again.";
    if (e.status === 403) return "You do not have access to this subsidiary.";
    if (e.status >= 500) return "The service is unavailable right now.";
    return e.message;
  }
  return (e as Error).message ?? "Something went wrong.";
}

type Form = {
  legalName: string;
  tradingName: string;
  location: string;
  geographyCode: string;
  sector: string;
  businessArea: string;
  reportingStatus: "pending" | "active" | "inactive";
  designatedPerson: string;
  contactEmail: string;
  contactPhone: string;
};

function toForm(s: SubsidiaryDTO): Form {
  return {
    legalName: s.legalName,
    tradingName: s.tradingName ?? "",
    location: s.location ?? "",
    geographyCode: s.geographyCode,
    sector: s.sector ?? "",
    businessArea: s.businessArea ?? "",
    reportingStatus: s.reportingStatus,
    designatedPerson: s.designatedPerson ?? "",
    contactEmail: s.contactEmail ?? "",
    contactPhone: s.contactPhone ?? "",
  };
}

/** Empty string means "cleared" to a user and `null` to the API — the column
 *  distinguishes null from '' and the DTO's transform collapses blanks, so send
 *  null explicitly rather than relying on that. */
const orNull = (v: string) => (v.trim().length > 0 ? v.trim() : null);

export default function SubsidiaryDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { user, setUser } = useAuthStore();

  const [subsidiary, setSubsidiary] = useState<SubsidiaryDTO | null>(null);
  const [locations, setLocations] = useState<LocationDTO[]>([]);
  const [summary, setSummary] = useState<SubsidiarySummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [geoConfirm, setGeoConfirm] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [locksOpen, setLocksOpen] = useState(false);

  const canManage = user?.role === "super_admin";

  const load = useCallback(
    async (resetForm: boolean) => {
      setLoadError(null);
      try {
        const [s, locs, sum] = await Promise.all([
          api.getSubsidiary(id),
          api.listLocations(id),
          api.getSubsidiarySummary(id),
        ]);
        setSubsidiary(s);
        setLocations(locs);
        setSummary(sum);
        if (resetForm) setForm(toForm(s));
      } catch (e) {
        // A subsidiary outside the caller's scope answers 404, never 403 — the
        // project-wide rule, so this covers "gone" and "never yours" alike.
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else {
          // Not just a toast: without this the render falls back to the
          // loading branch and an expired session looks like a spinner that
          // never resolves. The page has to say what happened.
          setLoadError(errMessage(e));
          toast.error(errMessage(e));
        }
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    // Reset per-id, not just on first mount. Without this a nav from a bad id
    // to a good one keeps the not-found screen, and panel→panel renders the
    // previous subsidiary as the new one until the fetch lands. Latent today —
    // no in-app link does either — but this is the repo's first dynamic route
    // and the next one will be copied from it.
    setNotFound(false);
    setLoadError(null);
    setLoading(true);
    api
      .me()
      .then(setUser)
      .catch((e) => toast.error(errMessage(e)));
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dirty =
    !!form && !!subsidiary && JSON.stringify(form) !== JSON.stringify(toForm(subsidiary));

  async function handleSave() {
    if (!form || !subsidiary) return;
    if (form.legalName.trim().length < 2) {
      toast.error("Legal name is required");
      return;
    }
    // Same reason as the register dialog: the geography decides which factor set
    // FUTURE records here resolve against, so it is confirmed rather than saved
    // silently (`subsidiaries_page.md` §9).
    if (subsidiary.geographyCode !== form.geographyCode) {
      setGeoConfirm({ from: subsidiary.geographyCode, to: form.geographyCode });
      return;
    }
    await persist();
  }

  async function persist() {
    if (!form) return;
    setSaving(true);
    try {
      await api.updateSubsidiary(id, {
        legalName: form.legalName.trim(),
        tradingName: orNull(form.tradingName),
        location: orNull(form.location),
        geographyCode: form.geographyCode,
        sector: orNull(form.sector),
        businessArea: orNull(form.businessArea),
        reportingStatus: form.reportingStatus,
        designatedPerson: orNull(form.designatedPerson),
        contactEmail: orNull(form.contactEmail),
        contactPhone: orNull(form.contactPhone),
      });
      // The register page's exact wording — the same event, so the same words.
      toast.success("Subsidiary settings updated successfully.");
      setGeoConfirm(null);
      await load(true);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (subsidiary) setForm(toForm(subsidiary));
    setGeoConfirm(null);
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-background">
        <Sidebar />
        <main className="pl-[280px] transition-all duration-300">
          <div className="space-y-4 p-6">
            <h1 className="text-2xl font-semibold">Subsidiary not found</h1>
            <p className="text-sm text-muted-foreground">
              This subsidiary does not exist, or you no longer have access to it.
            </p>
            <Button variant="outline" onClick={() => router.push("/subsidiaries")}>
              <ArrowLeft className="h-4 w-4" /> Back to subsidiaries
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px] transition-all duration-300">
        <div className="space-y-6 p-6">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Link
                href="/subsidiaries"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" /> Subsidiaries
              </Link>
              <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
                <Building2 className="h-5 w-5 text-primary" />
                {loading ? "Loading…" : (subsidiary?.legalName ?? "")}
              </h1>
              {subsidiary && (
                <p className="text-sm text-muted-foreground">
                  {geographyLabel(subsidiary.geographyCode)}
                  {subsidiary.sector ? ` · ${subsidiary.sector}` : ""}
                </p>
              )}
            </div>
            {subsidiary && (
              <Badge
                variant="outline"
                className={statusClass[subsidiary.reportingStatus]}
              >
                {subsidiary.reportingStatus}
              </Badge>
            )}
          </div>

          {!canManage && !loading && (
            <p className="rounded-lg border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
              You can view this subsidiary, but only a super_admin can change it.
            </p>
          )}

          {loadError ? (
            <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
              <p className="text-sm font-medium text-destructive">
                This subsidiary could not be loaded.
              </p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
              <Button variant="outline" onClick={() => void load(true)}>
                Try again
              </Button>
            </div>
          ) : loading || !form || !subsidiary ? (
            <p className="text-sm text-muted-foreground">Loading subsidiary…</p>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Details</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                  <Field label="Legal name *">
                    <Input
                      aria-label="Legal name"
                      value={form.legalName}
                      disabled={!canManage}
                      onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                    />
                  </Field>
                  <Field label="Trading name">
                    <Input
                      aria-label="Trading name"
                      value={form.tradingName}
                      disabled={!canManage}
                      onChange={(e) => setForm({ ...form, tradingName: e.target.value })}
                    />
                  </Field>
                  <Field label="Location">
                    <Input
                      aria-label="Location"
                      value={form.location}
                      disabled={!canManage}
                      onChange={(e) => setForm({ ...form, location: e.target.value })}
                    />
                  </Field>
                  {/* Labelled "Reporting geography", not "Geography": the
                      locations panel below has its own `Geography *`, and a
                      label-scoped selector matching both would be ambiguous. */}
                  <Field label="Reporting geography">
                    <Select
                      value={form.geographyCode}
                      disabled={!canManage}
                      onValueChange={(v) => setForm({ ...form, geographyCode: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {geographyOptions(
                          form.geographyCode,
                          subsidiary.geographyCode,
                        ).map((code) => (
                          <SelectItem key={code} value={code}>
                            {geographyLabel(code)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Sector">
                    <Input
                      aria-label="Sector"
                      value={form.sector}
                      disabled={!canManage}
                      onChange={(e) => setForm({ ...form, sector: e.target.value })}
                    />
                  </Field>
                  {/* Neither of these has ever had a UI, despite round-tripping
                      through the API since WP1. */}
                  <Field label="Business area">
                    <Input
                      aria-label="Business area"
                      value={form.businessArea}
                      disabled={!canManage}
                      onChange={(e) => setForm({ ...form, businessArea: e.target.value })}
                    />
                  </Field>
                  <Field label="Reporting status">
                    <Select
                      value={form.reportingStatus}
                      disabled={!canManage}
                      onValueChange={(v) =>
                        setForm({ ...form, reportingStatus: v as Form["reportingStatus"] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Scopes included">
                    <p className="pt-2 text-sm text-muted-foreground">
                      {subsidiary.includedScopes.join(", ")}
                    </p>
                  </Field>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Reporting contact</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Who to reach about this subsidiary&apos;s data — the person who
                    prepares or coordinates the inventory, not whoever signs it off.
                    Visible to everyone in this organisation, including an external
                    consultant, and kept in the audit trail, so prefer a{" "}
                    <strong>role mailbox</strong> over a personal number.
                  </p>
                  <div className="grid gap-4 md:grid-cols-3">
                    <Field label="Responsible person">
                      <Input
                        aria-label="Responsible person"
                        value={form.designatedPerson}
                        disabled={!canManage}
                        placeholder="Aylin Demir"
                        onChange={(e) =>
                          setForm({ ...form, designatedPerson: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Work email">
                      <Input
                        aria-label="Work email"
                        type="email"
                        value={form.contactEmail}
                        disabled={!canManage}
                        placeholder="esg@company.com"
                        onChange={(e) =>
                          setForm({ ...form, contactEmail: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Work phone">
                      <Input
                        aria-label="Work phone"
                        value={form.contactPhone}
                        disabled={!canManage}
                        placeholder="+90 212 000 00 00"
                        onChange={(e) =>
                          setForm({ ...form, contactPhone: e.target.value })
                        }
                      />
                    </Field>
                  </div>
                </CardContent>
              </Card>

              {canManage && (
                <div className="flex items-center gap-3">
                  <Button onClick={handleSave} disabled={saving || !dirty}>
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                  {/* A page has no Cancel-to-close, so discarding is explicit.
                      The register dialog's Cancel was the only way to prove a
                      declined edit never reached the server. */}
                  <Button
                    variant="outline"
                    onClick={discard}
                    disabled={saving || !dirty}
                  >
                    Discard changes
                  </Button>
                  {dirty && (
                    <span className="text-xs text-muted-foreground">
                      Unsaved changes
                    </span>
                  )}
                </div>
              )}

              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-primary" />
                    Operational locations
                  </CardTitle>
                  <Button variant="outline" size="sm" onClick={() => setLocksOpen(true)}>
                    <Lock className="h-4 w-4" /> Reporting periods
                  </Button>
                </CardHeader>
                <CardContent>
                  <LocationsPanel
                    subsidiary={subsidiary}
                    locations={locations}
                    canManage={canManage}
                    onChanged={() => load(false)}
                  />
                </CardContent>
              </Card>

              {summary && <DependentsCard summary={summary} />}
            </>
          )}
        </div>
      </main>

      <PeriodLocksDrawer
        subsidiary={locksOpen ? subsidiary : null}
        canManage={canManage}
        onClose={() => {
          setLocksOpen(false);
          void load(false);
        }}
      />

      <AlertDialog
        open={!!geoConfirm}
        onOpenChange={(open) => !open && setGeoConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change geography from {geoConfirm?.from} to {geoConfirm?.to}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Warning: Changing the geography will change the configured factor
              basis for geography dependent calculations. This may require
              recalculation of affected Scope 2 records for selected reporting
              periods. Do you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
            Records already committed keep the emission factor they were
            calculated with — those figures do not change. The new geography
            applies to records created from now on.
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={persist}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * What is under this subsidiary, and — when it cannot be deleted — why.
 *
 * The sentences come from the API, composed by the same function that writes
 * the 409. Restating them here would have been the drift the shared counter was
 * extracted to prevent, one level up.
 */
function DependentsCard({ summary }: { summary: SubsidiarySummaryDTO }) {
  const rows: [string, number][] = [
    ["Locations", summary.locations],
    ["Approved or locked records", summary.terminalRecords],
    ["Records awaiting review", summary.reviewRecords],
    ["Draft or rejected records", summary.openRecords],
    ["Closed reporting periods", summary.periodLocks],
    ["Reduction targets", summary.targets],
    ["Intensity denominators", summary.denominators],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>What depends on this subsidiary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
          {rows.map(([label, n]) => (
            <div key={label} className="flex justify-between border-b border-border/60 py-1">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="font-mono text-sm">{n}</dd>
            </div>
          ))}
        </dl>
        {summary.hasBlockingDependents ? (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
              <ShieldAlert className="h-4 w-4" />
              This subsidiary cannot be deleted
            </p>
            <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
              {summary.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing depends on this subsidiary, so it can be deleted from the
            register.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
