"use client";

import { useEffect } from "react";
import { watchSession } from "@/lib/session-watch";

/** Mounted once in the root layout: every page, not only the annual screens,
 *  follows a session that ends or changes hands in another tab. */
export function SessionWatch() {
  useEffect(() => {
    watchSession();
  }, []);
  return null;
}
