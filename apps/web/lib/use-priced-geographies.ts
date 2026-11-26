"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { geographyOptions } from "@/lib/types";

/**
 * A picker's geographies (inc26-group-tree, D10): `geographyOptions` narrowed
 * to those the factor library can price (`GET /factors/coverage`). `stored` is
 * the value an EXISTING record already holds — kept so a stored geography
 * never blanks its own control. A new record has none: a parent's unpriced
 * geography is not offered to it, and nothing is offered while coverage is
 * unread or unreadable, since the API would refuse it with 422
 * `geography_without_factors` (owner review of WP7, P2).
 */
export function pricedChoices(
  priced: readonly string[] | null,
  stored?: string | null,
  /** A new record's parent's geography: offered when the library prices it,
   *  even outside the selectable list (a facility of an EU company). */
  preferred?: string | null,
): string[] {
  // The selectable geographies (UK and Türkiye), as far as the library prices them.
  const offered = priced === null ? [] : geographyOptions().filter((g) => priced.includes(g));
  if (preferred && priced?.includes(preferred) && !offered.includes(preferred)) offered.push(preferred);
  if (stored && !offered.includes(stored)) offered.push(stored);
  return offered;
}

/** A new record's geography: `preferred` (a parent's) when priced, else the
 *  first priced selectable one, else none — never an unpriced value. */
export function pricedDefault(priced: readonly string[] | null, preferred?: string | null): string {
  const offered = pricedChoices(priced, null, preferred);
  return preferred && offered.includes(preferred) ? preferred : (offered[0] ?? "");
}

export interface PricedGeographies {
  /** The priced codes; `null` until read, and after a failed read. */
  priced: readonly string[] | null;
  /** The coverage read failed: nothing new can be offered. */
  failed: boolean;
  choices: (stored?: string | null, preferred?: string | null) => string[];
  defaultFor: (preferred?: string | null) => string;
}

export function usePricedGeographies(): PricedGeographies {
  const [priced, setPriced] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .factorCoverage()
      .then((c) => {
        if (live) setPriced([...new Set(c.entries.map((e) => e.geographyCode))]);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return {
    priced,
    failed,
    choices: (stored, preferred) => pricedChoices(priced, stored, preferred),
    defaultFor: (preferred) => pricedDefault(priced, preferred),
  };
}
