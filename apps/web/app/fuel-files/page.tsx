"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UploadTab } from "@/components/fuel-files/upload-tab";
import { UploadsTab } from "@/components/fuel-files/uploads-tab";
import { TrayTab } from "@/components/fuel-files/tray-tab";
import { AccountsTab } from "@/components/fuel-files/accounts-tab";
import { BatchesTab } from "@/components/fuel-files/batches-tab";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { useAuthStore } from "@/lib/store";
import { useSignOut } from "@/lib/use-sign-out";
import { can } from "@/lib/types";

/**
 * Fuel files (inc28-fuel-bulk D16): upload a card or tanker file, follow its
 * uploads, the batches they formed, the rows waiting in the tray, and the
 * accounts they map to. An auditor reads; it uploads nothing.
 */
export default function FuelFilesPage() {
  const t = useTranslations("fuelFiles");
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const showError = useStableErrorToast();
  const handleLogout = useSignOut();
  const [version, setVersion] = useState(0);
  const mayUpload = can(user?.role, "record.author");
  const [tab, setTab] = useState<string>("upload");
  // `?batch=<id>`: a batch's record in Data Entry links here; open that batch (D16).
  const [linkedBatch, setLinkedBatch] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("batch");
    if (id) {
      setTab("batches");
      setLinkedBatch(id);
    }
  }, []);

  useEffect(() => {
    api.me().then(setUser).catch(showError);
  }, [setUser, showError]);
  useEffect(() => {
    if (user && !mayUpload && tab === "upload") setTab(linkedBatch ? "batches" : "uploads");
  }, [user, mayUpload, tab, linkedBatch]);

  const bump = () => setVersion((v) => v + 1);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px] transition-all duration-300">
        <div className="space-y-6 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
              <p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
            </div>
            <SignOutButton onClick={handleLogout} />
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {mayUpload && <TabsTrigger value="upload">{t("tabs.upload")}</TabsTrigger>}
              <TabsTrigger value="uploads">{t("tabs.uploads")}</TabsTrigger>
              <TabsTrigger value="batches">{t("tabs.batches")}</TabsTrigger>
              <TabsTrigger value="tray">{t("tabs.tray")}</TabsTrigger>
              <TabsTrigger value="accounts">{t("tabs.accounts")}</TabsTrigger>
            </TabsList>
            {mayUpload && (
              <TabsContent value="upload" className="mt-4">
                <UploadTab onApplied={bump} />
              </TabsContent>
            )}
            <TabsContent value="uploads" className="mt-4">
              <UploadsTab role={user?.role} refreshKey={version} />
            </TabsContent>
            <TabsContent value="batches" className="mt-4">
              <BatchesTab user={user} refreshKey={version} initialOpen={linkedBatch} />
            </TabsContent>
            <TabsContent value="tray" className="mt-4">
              <TrayTab role={user?.role} refreshKey={version} onChanged={bump} />
            </TabsContent>
            <TabsContent value="accounts" className="mt-4">
              <AccountsTab role={user?.role} refreshKey={version} />
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
