"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { geographyOptions } from "@/lib/types";

/**
 * The geographies a picker offers (inc26-group-tree, D10): `geographyOptions`
 * narrowed to those the factor library can price (`GET /factors/coverage`),
 * always keeping the values the record already holds so a stored geography
 * never blanks its own control. The API refuses an unpriced one with 422
 * `geography_without_factors` either way, so a failed read offers the full list.
 */
export function usePricedGeographies(): (...current: (string | null | undefined)[]) => string[] {
  const [priced, setPriced] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .factorCoverage()
      .then((c) => {
        if (live) setPriced([...new Set(c.entries.map((e) => e.geographyCode))]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return (...current) => {
    const options = geographyOptions(...current);
    if (priced === null) return options;
    const kept = new Set(current.filter((c): c is string => Boolean(c)));
    return options.filter((g) => priced.includes(g) || kept.has(g));
  };
}
