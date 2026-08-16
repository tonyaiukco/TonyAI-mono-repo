'use client';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { MapPin } from 'lucide-react';
import { LocationsPanel } from './locations-panel';
import type { LocationDTO, SubsidiaryDTO } from '@/lib/types';

interface LocationsDrawerProps {
  /** Doubles as the open/closed signal. */
  subsidiary: SubsidiaryDTO | null;
  locations: LocationDTO[];
  /** Only super_admin may add/edit/delete (org structure). */
  canManage: boolean;
  onClose: () => void;
  /** Called after any successful mutation so the parent can refetch. */
  onChanged: () => Promise<void> | void;
}

/**
 * The locations panel in a sheet, for the subsidiary register.
 *
 * Everything that DOES anything now lives in `LocationsPanel`, which the
 * `/subsidiaries/[id]` control panel mounts inline. What is left here is the
 * sheet and its header — presentation. The split matters because the body owns
 * two confirmations (geography change, delete), and a second copy of it would
 * be a second place for those to quietly diverge.
 */
export function LocationsDrawer({
  subsidiary,
  locations,
  canManage,
  onClose,
  onChanged,
}: LocationsDrawerProps) {
  return (
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

            <div className="mt-6">
              <LocationsPanel
                subsidiary={subsidiary}
                locations={locations}
                canManage={canManage}
                onChanged={onChanged}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
