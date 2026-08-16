'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { geographyLabel, geographyOptions } from '@/lib/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { MapPin, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { LocationDTO, SubsidiaryDTO } from '@/lib/types';

interface LocationsPanelProps {
  /** Non-null here, unlike the drawer: the panel only renders inside a chosen
   *  subsidiary. The drawer keeps the nullable prop as its open/closed signal. */
  subsidiary: SubsidiaryDTO;
  locations: LocationDTO[];
  /** Only super_admin may add/edit/delete (org structure). */
  canManage: boolean;
  /** Called after any successful mutation so the parent can refetch. */
  onChanged: () => Promise<void> | void;
}

const emptyForm = { name: '', geographyCode: '', address: '', authorizedPerson: '' };

/**
 * Operational locations of one subsidiary (FR §1.1 third tier): list + CRUD,
 * with both of its confirmations.
 *
 * Extracted from `LocationsDrawer` for the `/subsidiaries/[id]` control panel.
 * Deliberately not copied: the geography confirmation below is the guard WP16
 * PR 1 added because a location's geography decides the emission factor exactly
 * as a subsidiary's does, and a copy that quietly lost it would have been caught
 * by nothing — the E2E for it drives the drawer path only. One body, two
 * mounts, one set of tests that follow it.
 */
export function LocationsPanel({
  subsidiary,
  locations,
  canManage,
  onChanged,
}: LocationsPanelProps) {
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [geoConfirm, setGeoConfirm] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // A new location defaults to its parent subsidiary's geography (editable).
  const freshForm = () => ({
    ...emptyForm,
    geographyCode: subsidiary?.geographyCode ?? '',
  });

  // Reset the form whenever the drawer targets another subsidiary.
  useEffect(() => {
    setForm(freshForm());
    setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsidiary?.id]);

  function startEdit(loc: LocationDTO) {
    setEditingId(loc.id);
    setForm({
      name: loc.name,
      geographyCode: loc.geographyCode,
      address: loc.address ?? '',
      authorizedPerson: loc.authorizedPerson ?? '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(freshForm());
  }

  /**
   * A location's geography drives the emission factor for every record entered
   * against it, exactly as the subsidiary's does — and the subsidiary dialog
   * confirms that change while this one silently accepted it. Same rule, same
   * warning, or the protection is a matter of which screen you happened to use.
   */
  async function handleSave() {
    const editing = editingId ? locations.find((l) => l.id === editingId) : null;
    if (editing && editing.geographyCode !== form.geographyCode) {
      setGeoConfirm({ from: editing.geographyCode, to: form.geographyCode });
      return;
    }
    await persist();
  }

  async function persist() {
    if (!subsidiary) return;
    if (form.name.trim().length < 1) {
      toast.error('Location name is required');
      return;
    }
    setSaving(true);
    try {
      if (!form.geographyCode) {
        toast.error('Geography is required');
        return;
      }
      if (editingId) {
        await api.updateLocation(editingId, {
          name: form.name.trim(),
          geographyCode: form.geographyCode,
          address: form.address || null,
          authorizedPerson: form.authorizedPerson || null,
        });
        toast.success('Location updated');
      } else {
        await api.createLocation({
          subsidiaryId: subsidiary.id,
          name: form.name.trim(),
          geographyCode: form.geographyCode,
          address: form.address || null,
          authorizedPerson: form.authorizedPerson || null,
        });
        toast.success('Location added');
      }
      cancelEdit();
      setGeoConfirm(null);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    try {
      await api.deleteLocation(deletingId);
      toast.success('Location deleted');
      if (editingId === deletingId) cancelEdit();
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }
  return (
    <>
      <div className="mt-6 space-y-6">
        {/* List */}
        {locations.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No locations recorded for this subsidiary yet.
          </p>
        ) : (
          <div className="space-y-2">
            {locations.map((loc) => (
              <div
                key={loc.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {loc.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {loc.address ?? 'No address'}
                    {loc.authorizedPerson ? ` · ${loc.authorizedPerson}` : ''}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => startEdit(loc)}
                      aria-label="Edit location"
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setDeletingId(loc.id)}
                      aria-label="Delete location"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add / edit form — super_admin only */}
        {canManage ? (
          <div className="space-y-4 border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">
                {editingId ? 'Edit location' : 'Add location'}
              </h4>
              {editingId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={cancelEdit}
                  className="h-7 gap-1 px-2 text-xs"
                >
                  <X className="h-3 w-3" />
                  Cancel edit
                </Button>
              )}
            </div>
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Istanbul HQ"
              />
            </div>
            <div className="space-y-2">
              <Label>Geography *</Label>
              <Select
                value={form.geographyCode}
                onValueChange={(v) => setForm({ ...form, geographyCode: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select geography" />
                </SelectTrigger>
                <SelectContent>
                  {/* UK + Türkiye, plus this location's own value if it
                      is something else — hiding a code the record holds
                      would blank the trigger. */}
                  {geographyOptions(
                    form.geographyCode,
                    subsidiary?.geographyCode,
                    locations.find((l) => l.id === editingId)?.geographyCode,
                  ).map((g) => (
                    <SelectItem key={g} value={g}>
                      {geographyLabel(g)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Drives the emission factor for records at this location.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Address</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="Levent, Istanbul"
              />
            </div>
            <div className="space-y-2">
              <Label>Authorized person</Label>
              <Input
                value={form.authorizedPerson}
                onChange={(e) =>
                  setForm({ ...form, authorizedPerson: e.target.value })
                }
                placeholder="Aylin Demir"
              />
            </div>
            <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
              <Plus className="h-4 w-4" />
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add location'}
            </Button>
          </div>
        ) : (
          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            Only a super_admin can add or modify locations.
          </p>
        )}
      </div>
      {/* Same warning the subsidiary dialog gives, for the same reason: this
          value decides the emission factor for future records here, while every
          committed record keeps the factor it was calculated with. */}
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
            Records already committed at this location keep the emission factor
            they were calculated with — those figures do not change. The new
            geography applies to records created here from now on, and to any
            draft or sent-back record the next time it is saved.
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={persist} disabled={saving}>
              {saving ? 'Saving…' : 'Continue'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete location?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the location and is recorded in the audit
              log. A location that activity records are attached to cannot be
              removed — those records would end up showing a different geography
              than the one they were calculated with.
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
    </>
  );
}
