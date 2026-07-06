'use client';

import { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface LocationsDrawerProps {
  subsidiary: SubsidiaryDTO | null;
  locations: LocationDTO[];
  /** Only super_admin may add/edit/delete (org structure). */
  canManage: boolean;
  onClose: () => void;
  /** Called after any successful mutation so the parent can refetch. */
  onChanged: () => Promise<void> | void;
}

const emptyForm = { name: '', address: '', authorizedPerson: '' };

/** Operational locations of one subsidiary (FR §1.1 third tier): list + CRUD. */
export function LocationsDrawer({
  subsidiary,
  locations,
  canManage,
  onClose,
  onChanged,
}: LocationsDrawerProps) {
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Reset the form whenever the drawer targets another subsidiary.
  useEffect(() => {
    setForm(emptyForm);
    setEditingId(null);
  }, [subsidiary?.id]);

  function startEdit(loc: LocationDTO) {
    setEditingId(loc.id);
    setForm({
      name: loc.name,
      address: loc.address ?? '',
      authorizedPerson: loc.authorizedPerson ?? '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
  }

  async function handleSave() {
    if (!subsidiary) return;
    if (form.name.trim().length < 1) {
      toast.error('Location name is required');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await api.updateLocation(editingId, {
          name: form.name.trim(),
          address: form.address || null,
          authorizedPerson: form.authorizedPerson || null,
        });
        toast.success('Location updated');
      } else {
        await api.createLocation({
          subsidiaryId: subsidiary.id,
          name: form.name.trim(),
          address: form.address || null,
          authorizedPerson: form.authorizedPerson || null,
        });
        toast.success('Location added');
      }
      cancelEdit();
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
      <Sheet open={!!subsidiary} onOpenChange={(open) => !open && onClose()}>
        <SheetContent className="w-[440px] overflow-y-auto sm:max-w-[440px]">
          {subsidiary && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-primary" />
                  Operational locations
                </SheetTitle>
                <SheetDescription>
                  {subsidiary.tradingName ?? subsidiary.legalName} ·{' '}
                  {locations.length} location{locations.length === 1 ? '' : 's'}
                </SheetDescription>
              </SheetHeader>

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
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete location?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the location. An audit log entry is recorded.
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
