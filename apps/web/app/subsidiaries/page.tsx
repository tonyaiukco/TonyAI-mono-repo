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
import { Building2, CheckCircle2, Clock, Globe, LogOut, MapPin, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { LocationsDrawer } from "@/components/subsidiaries/locations-drawer";
import type { LocationDTO, SubsidiaryDTO } from "@/lib/types";

const GEOGRAPHIES = ["UK", "TR", "EU"] as const;
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
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [locSubsidiaryId, setLocSubsidiaryId] = useState<string | null>(null);

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

  const canManageLocations = user?.role === "super_admin";
  const locSubsidiary = subsidiaries.find((s) => s.id === locSubsidiaryId) ?? null;
  const locCount = (subsidiaryId: string) =>
    locations.filter((l) => l.subsidiaryId === subsidiaryId).length;

  async function handleCreate() {
    if (form.legalName.trim().length < 2) {
      toast.error("Legal name is required");
      return;
    }
    setSaving(true);
    try {
      await api.createSubsidiary({
        legalName: form.legalName.trim(),
        tradingName: form.tradingName || null,
        location: form.location || null,
        geographyCode: form.geographyCode,
        sector: form.sector || null,
        reportingStatus: form.reportingStatus,
      });
      toast.success("Subsidiary created");
      setAddOpen(false);
      setForm(emptyForm);
      await refresh();
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
              <Button onClick={() => setAddOpen(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                Add Subsidiary
              </Button>
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
            <SummaryCard title="Geographies" value={geographies} icon={<Globe className="h-4 w-4 text-primary" />} hint="UK / TR / EU" />
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
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusClass[s.reportingStatus]}>
                            {s.reportingStatus}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingId(s.id)}
                            aria-label="Delete subsidiary"
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
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
                    {GEOGRAPHIES.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? "Saving…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LocationsDrawer
        subsidiary={locSubsidiary}
        locations={locations.filter((l) => l.subsidiaryId === locSubsidiaryId)}
        canManage={canManageLocations}
        onClose={() => setLocSubsidiaryId(null)}
        onChanged={refresh}
      />

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete subsidiary?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the subsidiary. An audit log entry is recorded.
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
