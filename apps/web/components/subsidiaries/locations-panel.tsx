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
import { LOCATION_TYPES, type LocationType } from '@/lib/types';
import { usePricedGeographies } from '@/lib/use-priced-geographies';
import { useTranslations } from 'use-intl';
import { geographyLabel } from '@/lib/vocabulary';
import { useErrorToast } from '@/lib/i18n/hooks';
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
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { LocationDTO, SubsidiaryDTO } from '@/lib/types';

interface LocationsPanelProps {
  /** Non-null here, unlike the drawer: the panel only renders inside a chosen
   *  subsidiary. The drawer keeps the nullable prop as its open/closed signal. */
  subsidiary: SubsidiaryDTO;
  locations: LocationDTO[];
  /** Only masterkey may add/edit/delete (org structure). */
  canManage: boolean;
  /** Called after any successful mutation so the parent can refetch. */
  onChanged: () => Promise<void> | void;
}

// `locationType` '' is "no type" (inc26-group-tree, RD12: optional).
const emptyForm = { name: '', geographyCode: '', address: '', authorizedPerson: '', locationType: '' };
const NO_TYPE = 'none';

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
  const t = useTranslations('subsidiaries');
  const tGeography = useTranslations('geography');
  const tCommon = useTranslations('common');
  const showError = useErrorToast();
  const [form, setForm] = useState(emptyForm);
  const pricedGeographies = usePricedGeographies();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [geoConfirm, setGeoConfirm] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // A new location defaults to its parent subsidiary's geography (editable).
  const freshForm = () => ({
    ...emptyForm,
    geographyCode: pricedGeographies.defaultFor(subsidiary?.geographyCode),
  });

  // Reset the form whenever the drawer targets another subsidiary.
  useEffect(() => {
    setForm(freshForm());
    setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsidiary?.id]);

  // Coverage read after the form was set: a new facility's default, once known.
  useEffect(() => {
    if (editingId || pricedGeographies.priced === null) return;
    setForm((f) => (f.geographyCode === '' ? { ...f, geographyCode: pricedGeographies.defaultFor(subsidiary?.geographyCode) } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricedGeographies.priced]);

  function startEdit(loc: LocationDTO) {
    setEditingId(loc.id);
    setForm({
      name: loc.name,
      geographyCode: loc.geographyCode,
      address: loc.address ?? '',
      authorizedPerson: loc.authorizedPerson ?? '',
      locationType: loc.locationType ?? '',
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
      toast.error(t('locations.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      if (!form.geographyCode) {
        toast.error(t('locations.geographyRequired'));
        return;
      }
      if (editingId) {
        await api.updateLocation(editingId, {
          name: form.name.trim(),
          geographyCode: form.geographyCode,
          address: form.address || null,
          authorizedPerson: form.authorizedPerson || null,
          locationType: (form.locationType || null) as LocationType | null,
        });
        toast.success(t('locations.updated'));
      } else {
        await api.createLocation({
          subsidiaryId: subsidiary.id,
          name: form.name.trim(),
          geographyCode: form.geographyCode,
          address: form.address || null,
          authorizedPerson: form.authorizedPerson || null,
          ...(form.locationType ? { locationType: form.locationType as LocationType } : {}),
        });
        toast.success(t('locations.added'));
      }
      cancelEdit();
      setGeoConfirm(null);
      await onChanged();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    try {
      await api.deleteLocation(deletingId);
      toast.success(t('locations.deleted'));
      if (editingId === deletingId) cancelEdit();
      await onChanged();
    } catch (e) {
      showError(e);
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
            {t('locations.empty')}
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
                    {loc.locationType ? `${t(`locations.types.${loc.locationType}`)} · ` : ''}
                    {loc.address ?? t('locations.noAddress')}
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
                      aria-label={t('locations.edit')}
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setDeletingId(loc.id)}
                      aria-label={t('locations.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add / edit form — masterkey only; never for a sector group, which
            holds no facility (TA021; owner's third review of WP7, P3). */}
        {subsidiary?.nodeType === 'sector_group' ? (
          <p className="border-t border-border pt-4 text-xs text-muted-foreground" data-testid="sector-group-no-facility">
            {t('tree.noFacilitySectorGroup')}
          </p>
        ) : canManage ? (
          <div className="space-y-4 border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">
                {editingId ? t('locations.editTitle') : t('locations.addTitle')}
              </h4>
              {editingId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={cancelEdit}
                  className="h-7 gap-1 px-2 text-xs"
                >
                  <X className="h-3 w-3" />
                  {t('locations.cancelEdit')}
                </Button>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('locations.name')}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('locations.namePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('locations.geography')}</Label>
              <Select
                value={form.geographyCode}
                onValueChange={(v) => setForm({ ...form, geographyCode: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('locations.geographyPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {/* UK + Türkiye, plus this location's own value if it
                      is something else — hiding a code the record holds
                      would blank the trigger. */}
                  {/* Priced geographies; an edited facility keeps the one
                      it already holds, a new one never inherits an unpriced
                      geography from its company (owner review of WP7, P2). */}
                  {pricedGeographies.choices(editingId ? locations.find((l) => l.id === editingId)?.geographyCode : undefined, subsidiary?.geographyCode).map((g) => (
                    <SelectItem key={g} value={g}>
                      {geographyLabel(g, tGeography)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('locations.geographyHint')}
              </p>
              {pricedGeographies.failed && (
                <p className="text-xs text-destructive">{t('fields.geographyUnavailable')}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('locations.type')}</Label>
              <Select
                value={form.locationType || NO_TYPE}
                onValueChange={(v) => setForm({ ...form, locationType: v === NO_TYPE ? '' : v })}
              >
                <SelectTrigger aria-label={t('locations.type')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TYPE}>{t('locations.typeNone')}</SelectItem>
                  {LOCATION_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`locations.types.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('locations.address')}</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder={t('locations.addressPlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('locations.person')}</Label>
              <Input
                value={form.authorizedPerson}
                onChange={(e) =>
                  setForm({ ...form, authorizedPerson: e.target.value })
                }
                placeholder={t('locations.personPlaceholder')}
              />
            </div>
            <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
              <Plus className="h-4 w-4" />
              {saving ? tCommon('saving') : editingId ? t('locations.save') : t('locations.add')}
            </Button>
          </div>
        ) : (
          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            {t('locations.readOnly')}
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
              {t('geographyChange.title', { from: geoConfirm?.from ?? '', to: geoConfirm?.to ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('geographyChange.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
            {t('geographyChange.locationNote')}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={persist} disabled={saving}>
              {saving ? tCommon('saving') : t('geographyChange.continue')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('locations.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('locations.deleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('locations.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
