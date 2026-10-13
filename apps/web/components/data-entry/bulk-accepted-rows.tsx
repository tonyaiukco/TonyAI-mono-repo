"use client";

import { useTranslations } from "use-intl";
import periodMessages from "@/messages/en/periods.json";
import type { BulkUploadAcceptedRow } from "@/lib/types";
import { bulkActivityLabel } from "@/lib/bulk-upload-view";

/** Keep every accepted row inspectable before apply, including its fuel or gas. */
export function AcceptedRows({ rows }: { rows: BulkUploadAcceptedRow[] }) {
  const t = useTranslations("dataEntry");
  const tCategory = useTranslations("categories");
  const tPeriod = useTranslations("periods");
  if (rows.length === 0) return null;
  return (
    <div className="max-h-80 overflow-auto rounded-lg border" data-testid="bulk-accepted-rows">
      <table className="w-full text-left text-xs">
        <caption className="p-3 text-left font-medium">{t("bulkPreview.title")}</caption>
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th scope="col" className="p-2">{t("bulkPreview.row")}</th>
            <th scope="col" className="p-2">{t("bulkColumns.reportingYear")}</th>
            <th scope="col" className="p-2">{t("bulkColumns.periodValue")}</th>
            <th scope="col" className="p-2">{t("bulkColumns.category")}</th>
            <th scope="col" className="p-2">{t("bulkColumns.activityType")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.row} className="border-t">
              <td className="p-2 font-mono">{row.row}</td>
              <td className="p-2">{row.reportingYear}</td>
              <td className="p-2">{Object.hasOwn(periodMessages.values, row.periodValue)
                ? tPeriod(`values.${row.periodValue as keyof typeof periodMessages.values}`) : row.periodValue}</td>
              <td className="p-2">{tCategory(row.category)}</td>
              <td className="p-2">{bulkActivityLabel(row.activityType, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
