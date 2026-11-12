'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { sealDateIndex, type SealDates } from '@/lib/release-seal-view';

/**
 * The library's seal dates, loaded once per page (UAT round 2, S2). Advisory:
 * a failure leaves the dates out without a toast — a missing date must never
 * block Data Entry or review, and the page's own calls already report a lost
 * session.
 */
export function useReleaseSealDates(): SealDates | null {
  const [dates, setDates] = useState<SealDates | null>(null);
  useEffect(() => {
    let live = true;
    api
      .listFactorReleases()
      .then((releases) => live && setDates(sealDateIndex(releases)))
      .catch(() => live && setDates(null));
    return () => {
      live = false;
    };
  }, []);
  return dates;
}
