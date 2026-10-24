"use client";

import { LogOut } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Every page header's Sign out. The test id is what e2e's `switchUser` clicks,
 * so a user signed in to the Turkish UI can be switched like any other.
 */
export function SignOutButton({
  onClick,
  className,
  size,
}: {
  onClick: () => void;
  className?: string;
  size?: "sm";
}) {
  const t = useTranslations("common");
  return (
    <Button variant="outline" size={size} onClick={onClick} className={cn("gap-2", className)} data-testid="sign-out">
      <LogOut className="h-4 w-4" />
      {t("signOut")}
    </Button>
  );
}
