"use client";

import { Button } from "@/components/ui/button";

/** The one control that reads the next `CursorPage` — shown only while the API says there is more. */
export function LoadMoreButton({
  hasMore,
  loading,
  onClick,
  label,
  testId,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  label: string;
  testId?: string;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center">
      <Button variant="outline" size="sm" onClick={onClick} disabled={loading} data-testid={testId}>
        {label}
      </Button>
    </div>
  );
}
