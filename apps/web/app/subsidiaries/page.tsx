"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Building2, CheckCircle2, Clock, Globe, Lock, LogOut, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { LocationsDrawer } from "@/components/subsidiaries/locations-drawer";
import { PeriodLocksDrawer } from "@/components/subsidiaries/period-locks-drawer";
import { geographyLabel, geographyOptions } from "@/lib/types";
import type { LocationDTO, SubsidiaryDTO } from "@/lib/types";

const STATUSES = ["pending", "active", "inactive"] as const;

const statusClass: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  inactive: "bg-red-500/15 text-red-600 border-red-500/30",
};

const emptyForm = {
  legalName: "",
  tradingName: "",
  location: "",
  geographyCode: "TR",
  sector: "",
  reportingStatus: "pending" as "pending" | "active" | "inactive",
};

export default function SubsidiariesPage() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [locations, setLocations] = useState<LocationDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  // Set only while the geography confirmation is open; the save resumes from
  // the confirm action rather than being re-driven through handleSave.
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  /**
   * Locations collected before the subsidiary exists, sent with the create.
   *
   * Not `<LocationsPanel>`: that component persists every change immediately
   * and is keyed on ids that only exist server-side. Its two confirmations —
   * geography change, delete — protect committed records, and a row that has
   * never existed has none, so reusing it would mean flags switching off
   * exactly the guards that justify it.
   */
  const [draftLocations, setDraftLocations] = useState<
    { name: string; geographyCode: string }[]
  >([]);
  const [draftName, setDraftName] = useState("");
  const [draftGeo, setDraftGeo] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [locSubsidiaryId, setLocSubsidiaryId] = useState<string | null>(null);
  const [lockSubsidiaryId, setLockSubsidiaryId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [list, locs] = await Promise.all([
        api.listSubsidiaries(),
        api.listLocations(),
      ]);
      setSubsidiaries(list);
      setLocations(locs);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((e) => toast.error((e as Error).message));
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = subsidiaries.length;
  const active = subsidiaries.filter((s) => s.reportingStatus === "active").length;
  const pending = subsidiaries.filter((s) => s.reportingStatus === "pending").length;
  const geographies = new Set(subsidiaries.map((s) => s.geographyCode)).size;

  // Single source of truth for super_admin-only write controls on this page
  // (create/delete subsidiary, and the lock/location write forms in the drawers).
  // The API + RLS remain the real enforcement; hiding these is UX/defense-in-depth.
  const canManage = user?.role === "super_admin";
  const locSubsidiary = subsidiaries.find((s) => s.id === locSubsidiaryId) ?? null;
  const lockSubsidiary = subsidiaries.find((s) => s.id === lockSubsidiaryId) ?? null;
  const locCount = (subsidiaryId: string) =>
    locations.filter((l) => l.subsidiaryId === subsidiaryId).length;

  function openAdd() {
    setForm(emptyForm);
    setDraftLocations([]);
    setDraftName("");
    setDraftGeo("");
    setAddOpen(true);
  }

  function addDraftLocation() {
    const name = draftName.trim();
    if (name.length === 0) {
      toast.error("A location needs a name");
      return;
    }
    if (draftLocations.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`"${name}" is already in the list`);
      return;
    }
    setDraftLocations([
      ...draftLocations,
      { name, geographyCode: draftGeo || form.geographyCode },
    ]);
    setDraftName("");
    setDraftGeo("");
  }

  async function handleSave() {
    if (form.legalName.trim().length < 2) {
      toast.error("Legal name is required");
      return;
    }
    // Round-1 SUB-3: locations are the subsidiary's operational borders, and
    // WP17's completeness denominator is their count — so the form asks for one
    // rather than letting a subsidiary start life with undefined borders. The
    // API stays permissive, deliberately (see CreateSubsidiaryDto).
    if (draftLocations.length === 0) {
      toast.error("Add at least one operational location");
      return;
    }
    await persist();
  }

  async function persist() {
    setSaving(true);
    try {
      const body = {
        legalName: form.legalName.trim(),
        tradingName: form.tradingName || null,
        location: form.location || null,
        geographyCode: form.geographyCode,
        sector: form.sector || null,
        reportingStatus: form.reportingStatus,
      };
      const created = await api.createSubsidiary({ ...body, locations: draftLocations });
      toast.success("Subsidiary created");
      setAddOpen(false);
      setForm(emptyForm);
      setDraftLocations([]);
      // Straight to its own page: everything else about a subsidiary — contact,
      // more locations, what depends on it — lives there, and landing on the
      // register would mean finding the row you just made.
      router.push(`/subsidiaries/${created.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    try {
      await api.deleteSubsidiary(deletingId);
      toast.success("Subsidiary deleted");
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px] transition-all duration-300">
        <div className="space-y-6 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Subsidiaries</h1>
              <p className="mt-1 text-muted-foreground">
                Live data from the TonyAI API
                {user ? ` · ${user.fullName} (${user.role})` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {canManage && (
                <Button onClick={openAdd} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add Subsidiary
                </Button>
              )}
              <Button variant="outline" onClick={handleLogout} className="gap-2">
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <SummaryCard title="Total" value={total} icon={<Building2 className="h-4 w-4 text-primary" />} hint="Accessible to you" />
            <SummaryCard title="Active" value={active} icon={<CheckCircle2 className="h-4 w-4 text-primary" />} hint="Reporting active" />
            <SummaryCard title="Pending" value={pending} icon={<Clock className="h-4 w-4 text-primary" />} hint="Awaiting onboarding" />
            <SummaryCard title="Geographies" value={geographies} icon={<Globe className="h-4 w-4 text-primary" />} hint="in use across the register" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Subsidiary register</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
              ) : subsidiaries.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No subsidiaries accessible to your account.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Legal name</TableHead>
                      <TableHead>Trading name</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Geo</TableHead>
                      <TableHead>Sector</TableHead>
                      <TableHead>Locations</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subsidiaries.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.legalName}</TableCell>
                        <TableCell className="text-muted-foreground">{s.tradingName ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{s.location ?? "—"}</TableCell>
                        <TableCell>{s.geographyCode}</TableCell>
                        <TableCell className="text-muted-foreground">{s.sector ?? "—"}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLocSubsidiaryId(s.id)}
                            className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                            aria-label="Manage locations"
                          >
                            <MapPin className="h-3.5 w-3.5" />
                            {locCount(s.id)}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLockSubsidiaryId(s.id)}
                            className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                            aria-label="Manage period locks"
                          >
                            <Lock className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusClass[s.reportingStatus]}>
                            {s.reportingStatus}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {canManage && (
                            <>
                              {/* The register is a list; everything about one
                                  subsidiary now lives on its own page, which is
                                  where contact details and the dependent counts
                                  are. */}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => router.push(`/subsidiaries/${s.id}`)}
                                aria-label="Open subsidiary"
                              >
                                <Pencil className="h-4 w-4 text-muted-foreground" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setDeletingId(s.id)}
                                aria-label="Delete subsidiary"
                              >
                                <Trash2 className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add subsidiary</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Legal name *">
              <Input
                value={form.legalName}
                onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                placeholder="TonyAI Energy A.Ş."
              />
            </Field>
            <Field label="Trading name">
              <Input
                value={form.tradingName}
                onChange={(e) => setForm({ ...form, tradingName: e.target.value })}
              />
            </Field>
            <Field label="Location">
              <Input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="Istanbul, Turkey"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Geography">
                <Select
                  value={form.geographyCode}
                  onValueChange={(v) => setForm({ ...form, geographyCode: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* The list is UK + Türkiye, plus whatever this record
                        already holds — otherwise editing the seeded EU
                        subsidiary would bind the Select to a value with no
                        matching item and render a blank trigger. */}
                    {geographyOptions(form.geographyCode).map((g) => (
                      <SelectItem key={g} value={g}>
                        {geographyLabel(g)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Status">
                <Select
                  value={form.reportingStatus}
                  onValueChange={(v) =>
                    setForm({ ...form, reportingStatus: v as typeof form.reportingStatus })
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
            </div>
            <Field label="Sector">
              <Input
                value={form.sector}
                onChange={(e) => setForm({ ...form, sector: e.target.value })}
                placeholder="Energy"
              />
            </Field>
          </div>

          {/* Operational locations, collected as a draft and written with the
              subsidiary in one transaction (round-1 SUB-3). The geography
              select is labelled "Site geography" so it cannot be confused with
              the subsidiary's own "Geography" — they sit in one dialog, and a
              label-scoped selector matching both would be ambiguous. */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <MapPin className="h-4 w-4 text-primary" />
              Operational locations
            </div>
            <p className="text-xs text-muted-foreground">
              A subsidiary&apos;s locations are its reporting borders — add at
              least one. You can add more later on its page.
            </p>

            {draftLocations.length > 0 && (
              <ul className="space-y-1">
                {draftLocations.map((l, i) => (
                  <li
                    key={`${l.name}-${i}`}
                    className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2 text-sm"
                  >
                    <span>
                      {l.name}{" "}
                      <span className="text-muted-foreground">
                        · {geographyLabel(l.geographyCode)}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${l.name}`}
                      onClick={() =>
                        setDraftLocations(draftLocations.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
              <Input
                aria-label="Location name"
                placeholder="Istanbul HQ"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
              <Select
                value={draftGeo || form.geographyCode}
                onValueChange={setDraftGeo}
              >
                <SelectTrigger aria-label="Site geography" className="sm:w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {geographyOptions(draftGeo || form.geographyCode).map((code) => (
                    <SelectItem key={code} value={code}>
                      {geographyLabel(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={addDraftLocation}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LocationsDrawer
        subsidiary={locSubsidiary}
        locations={locations.filter((l) => l.subsidiaryId === locSubsidiaryId)}
        canManage={canManage}
        onClose={() => setLocSubsidiaryId(null)}
        onChanged={refresh}
      />

      <PeriodLocksDrawer
        subsidiary={lockSubsidiary}
        canManage={canManage}
        onClose={() => setLockSubsidiaryId(null)}
      />

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete subsidiary?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the subsidiary and is recorded in the
              audit log. A subsidiary that still holds activity records,
              locations, targets or closed reporting periods cannot be removed —
              deleting it would destroy them, and their evidence with them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
  hint,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
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
