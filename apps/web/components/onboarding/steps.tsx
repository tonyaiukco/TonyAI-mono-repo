import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { Info, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { CompanyFields, EMPTY_COMPANY_FORM, type CompanyForm } from "@/components/subsidiaries/company-fields";
import { DeclarationEditor } from "@/components/inventory-boundary/declaration-editor";
import { CentralReporterDialog } from "@/components/users/central-reporter-dialog";
import { ReportingContextBar, ReportingContextInvalid } from "@/components/reporting-context/reporting-context-bar";
import { api, ApiError } from "@/lib/api";
import { useErrorToast } from "@/lib/i18n/hooks";
import { emptyDraft, draftFromSnapshot } from "@/lib/inventory-boundary-form";
import { gapLines, versionState } from "@/lib/inventory-boundary-view";
import {
  approachWrite,
  boundaryCompanies,
  companiesOf,
  companyParents,
  grantCandidates,
  holdingAction,
  rootOf,
  sectorGroupsOf,
  unusedSuggestions,
  type SectorGroupSuggestion,
} from "@/lib/onboarding-view";
import { parseNaceCode, parseSharePercent } from "@/lib/subsidiaries-view";
import { usePricedGeographies } from "@/lib/use-priced-geographies";
import { boundaryCalls } from "@/lib/use-boundary-calls";
import { useReportingContext } from "@/lib/use-reporting-context";
import { invitePayload } from "@/lib/users-view";
import {
  CONSOLIDATION_APPROACHES,
  SUPPORTED_LOCALES,
  UPCOMING_CONSOLIDATION_APPROACHES,
  type ConsolidationApproach,
  type CreateSubsidiaryInput,
  type InventoryBoundaryVersionDTO,
  type Locale,
  type PutInventoryBoundarySubsidiaryRequest,
  type SubsidiaryDTO,
  type UserSummaryDTO,
} from "@/lib/types";

/**
 * The setup wizard's steps (inc26-central-reporter-onboarding, INC-2.6 §7.1;
 * design D10): each a view over endpoints that already exist. A step reads
 * what is stored when it opens and writes nothing unless the masterkey adds
 * or changes something (C8). `onNext` moves on; a step that must be passed
 * first (the holding) calls it only once passed.
 */

export interface StepProps {
  nodes: SubsidiaryDTO[];
  reload: () => Promise<SubsidiaryDTO[]>;
  onNext: () => void;
  footer: (next: { label?: string; onClick: () => void; busy?: boolean; disabled?: boolean }) => React.ReactNode;
}

// --- Step 1: the holding ---------------------------------------------------------

export function HoldingStep({ nodes, reload, onNext, footer }: StepProps) {
  const t = useTranslations("onboarding");
  const showError = useErrorToast();
  const pricedGeos = usePricedGeographies();
  const root = rootOf(nodes);
  const [name, setName] = useState(root?.tradingName ?? "");
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(root?.tradingName ?? ""), [root?.id, root?.tradingName]);

  async function next() {
    const action = holdingAction(root, name);
    if (action.kind === "invalid") {
      setMissing(true);
      return;
    }
    setBusy(true);
    try {
      if (action.kind === "create") {
        // C11: the root, created as the company screen creates a first company.
        const body: CreateSubsidiaryInput = {
          legalName: action.tradingName,
          tradingName: action.tradingName,
          nodeType: "holding",
          geographyCode: pricedGeos.defaultFor(),
          locations: [],
        };
        await api.createSubsidiary(body);
      } else if (action.kind === "rename") {
        await api.updateSubsidiary(action.id, { tradingName: action.tradingName });
      }
      await reload();
      onNext();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("holding.description")}</p>
      <div className="space-y-2">
        <Label htmlFor="onboarding-trading-name">{t("holding.label")}</Label>
        <Input
          id="onboarding-trading-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setMissing(false);
          }}
          data-testid="onboarding-trading-name"
        />
        {missing && <p className="text-xs text-destructive" data-testid="onboarding-holding-missing">{t("holding.required")}</p>}
      </div>
      {footer({ onClick: next, busy })}
    </div>
  );
}

// --- Step 2: the consolidation approach --------------------------------------------

export function ApproachStep({ onNext, footer }: StepProps) {
  const t = useTranslations("onboarding");
  const showError = useErrorToast();
  const [stored, setStored] = useState<ConsolidationApproach | null>(null);
  const [chosen, setChosen] = useState<ConsolidationApproach | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getOrganisation().then((o) => {
      setStored(o.consolidationApproach);
      setChosen(o.consolidationApproach);
    }, showError);
  }, [showError]);

  async function next() {
    if (!stored || !chosen) return;
    const write = approachWrite(stored, chosen);
    setBusy(true);
    try {
      if (write) await api.setConsolidationApproach({ consolidationApproach: write });
      onNext();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("approach.description")}</p>
      <RadioGroup value={chosen ?? undefined} onValueChange={(v) => setChosen(v as ConsolidationApproach)} data-testid="onboarding-approach">
        {CONSOLIDATION_APPROACHES.map((a) => (
          <label key={a} className="flex items-center gap-2 text-sm">
            <RadioGroupItem value={a} id={`approach-${a}`} />
            {t(`approach.options.${a}`)}
          </label>
        ))}
        {UPCOMING_CONSOLIDATION_APPROACHES.map((a) => (
          <label key={a} className="flex items-center gap-2 text-sm text-muted-foreground">
            <RadioGroupItem value={a} id={`approach-${a}`} disabled />
            {t(`approach.options.${a}`)} · {t("approach.comingSoon")}
          </label>
        ))}
      </RadioGroup>
      {footer({ onClick: next, busy, disabled: chosen === null })}
    </div>
  );
}

// --- Step 3: sector groups -----------------------------------------------------------

export function SectorGroupsStep({ nodes, reload, onNext, footer }: StepProps) {
  const t = useTranslations("onboarding");
  const locale = useLocale();
  const showError = useErrorToast();
  const root = rootOf(nodes);
  const groups = sectorGroupsOf(nodes);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const suggestion = (key: SectorGroupSuggestion) => t(`sectorGroups.suggestions.${key}`);

  async function add(groupName: string) {
    if (!root || groupName.trim().length < 2) return;
    setBusy(true);
    try {
      await api.createSubsidiary({ legalName: groupName.trim(), nodeType: "sector_group", parentId: root.id, locations: [] });
      setName("");
      await reload();
      toast.success(t("sectorGroups.created"));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("sectorGroups.description")}</p>
      <div className="flex flex-wrap gap-2" data-testid="onboarding-sector-suggestions">
        {unusedSuggestions(nodes, suggestion, locale).map((key) => (
          <Button key={key} variant="outline" size="sm" disabled={busy} onClick={() => void add(suggestion(key))}>
            <Plus className="mr-1 h-3 w-3" />
            {suggestion(key)}
          </Button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sectorGroups.nameLabel")}
          aria-label={t("sectorGroups.nameLabel")}
          data-testid="onboarding-sector-name"
        />
        <Button disabled={busy || name.trim().length < 2} onClick={() => void add(name)}>
          {t("sectorGroups.add")}
        </Button>
      </div>
      <NodeList title={t("sectorGroups.list")} empty={t("sectorGroups.none")} names={groups.map((g) => g.legalName)} testId="onboarding-sector-list" />
      {footer({ onClick: onNext })}
    </div>
  );
}

// --- Step 4: companies ----------------------------------------------------------------

export function CompaniesStep({ nodes, reload, onNext, footer }: StepProps) {
  const t = useTranslations("onboarding");
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const pricedGeos = usePricedGeographies();
  const parents = companyParents(nodes);
  const root = rootOf(nodes);
  const [form, setForm] = useState<CompanyForm>({ ...EMPTY_COMPANY_FORM });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm((f) => ({
      ...f,
      parentId: f.parentId || root?.id || "",
      geographyCode: f.geographyCode || (pricedGeos.priced ? pricedGeos.defaultFor(root?.geographyCode) : ""),
    }));
    // `priced` only: the hook answers a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root?.id, root?.geographyCode, pricedGeos.priced]);

  async function add() {
    if (form.legalName.trim().length < 2) return void toast.error(t("companies.legalNameMissing"));
    if (!form.geographyCode) return void toast.error(t("companies.geographyRequired"));
    const share = parseSharePercent(form.sharePercent, locale);
    if (share === "invalid") return void toast.error(t("companies.sharePercentInvalid"));
    const nace = parseNaceCode(form.naceCode);
    if (nace === "invalid") return void toast.error(t("companies.naceInvalid"));
    setBusy(true);
    try {
      await api.createSubsidiary({
        legalName: form.legalName.trim(),
        tradingName: form.tradingName || null,
        location: form.location || null,
        sector: form.sector || null,
        reportingStatus: form.reportingStatus,
        ...(form.parentId ? { parentId: form.parentId } : {}),
        ...(form.associate ? { control: "associate" as const } : {}),
        naceCode: nace,
        sharePercent: share,
        nodeType: "company",
        geographyCode: form.geographyCode,
        locations: [],
      });
      setForm({ ...EMPTY_COMPANY_FORM, parentId: form.parentId, geographyCode: form.geographyCode });
      await reload();
      toast.success(t("companies.created"));
    } catch (e) {
      // The tree's refusals in the company screen's words (`errors` catalogue).
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("companies.description")}</p>
      <p className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-900" data-testid="onboarding-fuel-hint">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("companies.hint")}
      </p>
      <div className="space-y-4 rounded-md border p-3" data-testid="onboarding-company-form">
        <CompanyFields
          form={form}
          onChange={setForm}
          subsidiaries={nodes}
          parentOptions={parents}
          typeOptions={["company"]}
          canManage
          geographyChoices={(preferred) => pricedGeos.choices(undefined, preferred)}
          geographyFailed={pricedGeos.failed}
        />
        <Button disabled={busy} onClick={() => void add()} data-testid="onboarding-company-add">
          {t("companies.add")}
        </Button>
      </div>
      <NodeList title={t("companies.list")} empty={t("companies.none")} names={companiesOf(nodes).map((c) => (c.control === "associate" ? t("companies.associateName", { name: c.legalName }) : c.legalName))} testId="onboarding-company-list" />
      {footer({ onClick: onNext })}
    </div>
  );
}

// --- Step 5: inventory boundaries ---------------------------------------------------------

export function BoundariesStep(props: StepProps) {
  // The reporting context reads the URL (`useSearchParams`), which Next wants under Suspense.
  return (
    <Suspense fallback={null}>
      <BoundariesInYear {...props} />
    </Suspense>
  );
}

function BoundariesInYear({ nodes, onNext, footer }: StepProps) {
  const t = useTranslations("onboarding");
  const showError = useErrorToast();
  // The selected reporting year, as on the boundary screen (owner review of WP8, P2).
  const contextView = useReportingContext();
  const year = contextView.status === "ready" ? contextView.context.year : null;
  const companies = boundaryCompanies(nodes);
  const [detail, setDetail] = useState<InventoryBoundaryVersionDTO | null>(null);
  const [editing, setEditing] = useState<SubsidiaryDTO | null>(null);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  // Reads on entry and writes nothing (D10): the year's newest version, if any.
  // Each load is numbered: an answer for a year the bar has left is dropped
  // (security review), so the version on screen is always the year's.
  const loadSeq = useRef(0);
  // Nothing is declared until the year's versions are read: a save before then
  // could open a version beside a confirmed one it never saw.
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    if (year === null) return;
    const seq = ++loadSeq.current;
    setLoaded(false);
    const newest = (await boundaryCalls.listYear(year))[0];
    const opened = newest ? await boundaryCalls.open(newest.id) : null;
    if (seq !== loadSeq.current) return;
    setDetail(opened);
    setLoaded(true);
  }, [year]);
  useEffect(() => {
    load().catch(showError);
  }, [load, showError]);

  const open = detail ? versionState(detail) === "open" : true;
  const declared = (id: string) => !!detail && draftFromSnapshot(detail.boundary, id) !== null;
  // One object per opened editor: a re-render (Save's busy state) must not hand
  // the editor a new start and wipe what was typed (owner review of WP8, P2).
  const initial = useMemo(
    () => (editing && detail ? draftFromSnapshot(detail.boundary, editing.id) : null) ?? emptyDraft(),
    [detail, editing],
  );

  async function edit(company: SubsidiaryDTO) {
    try {
      setSites(await boundaryCalls.sitesOf(company.id));
      setEditing(company);
    } catch (e) {
      showError(e);
    }
  }

  async function save(request: PutInventoryBoundarySubsidiaryRequest) {
    if (!editing || year === null || !loaded) return;
    // Never into another year's version than the one the bar shows.
    if (detail && detail.reportingYear !== year) return void (await load().catch(showError));
    setSaving(true);
    try {
      // Into the version on screen; the first saved declaration opens one when the year had none.
      setDetail(await boundaryCalls.declare(detail?.id ?? null, year, editing.id, request));
      toast.success(t("boundaries.saved"));
      setEditing(null);
    } catch (e) {
      showError(e);
      // Confirmed, deleted, or opened by someone else, meanwhile: show the year as it is now.
      if (e instanceof ApiError && (e.code === "boundary_frozen" || e.code === "boundary_draft_open" || e.code === "boundary_not_found")) {
        setEditing(null);
        await load().catch(showError);
      }
    } finally {
      setSaving(false);
    }
  }

  async function confirm() {
    if (!detail) return;
    try {
      setDetail(await boundaryCalls.confirm(detail.id));
    } catch (e) {
      showError(e);
    }
  }

  if (contextView.status === "invalid") {
    return <ReportingContextInvalid invalid={contextView.invalid} onReset={contextView.reset} />;
  }
  if (year === null) return null;
  return (
    <div className="space-y-4">
      <ReportingContextBar context={contextView.context} subsidiaries={null} onSelect={contextView.select} fields={["year"]} />
      <p className="text-sm text-muted-foreground">{t("boundaries.description", { year })}</p>
      <p className="text-xs text-muted-foreground" data-testid="onboarding-matrix-note">{t("boundaries.matrixNote")}</p>
      {companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("boundaries.none")}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="onboarding-boundary-list">
          {companies.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 p-2 text-sm">
              <span>{c.legalName}</span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{declared(c.id) ? t("boundaries.declared") : t("boundaries.notDeclared")}</span>
                <Button size="sm" variant="outline" disabled={!open || !loaded} onClick={() => void edit(c)}>
                  {declared(c.id) ? t("boundaries.edit") : t("boundaries.declare")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {detail && open && (
        <Button variant="outline" size="sm" onClick={() => void confirm()} data-testid="onboarding-boundary-confirm">
          {t("boundaries.confirm")}
        </Button>
      )}
      {detail && !open && <p className="text-xs text-muted-foreground">{t("boundaries.confirmed")}</p>}
      {editing && (
        <DeclarationEditor
          open
          onOpenChange={(o) => !o && setEditing(null)}
          title={t("boundaries.editorTitle", { name: editing.legalName })}
          readOnly={false}
          initial={initial}
          sites={sites}
          gaps={detail ? gapLines(detail, editing.id) : []}
          saving={saving}
          onSave={(request) => void save(request)}
        />
      )}
      {footer({ onClick: onNext })}
    </div>
  );
}

// --- Steps 6 and 7: people -------------------------------------------------------------------

/** Every account of the organisation, across all pages of `GET /users`. */
async function everyUser(): Promise<UserSummaryDTO[]> {
  const all: UserSummaryDTO[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listUsersPage(cursor ? { cursor } : {});
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

export function SuperAdminsStep({ nodes, onNext, footer }: StepProps) {
  const t = useTranslations("onboarding");
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const tUsers = useTranslations("users");
  const companies = boundaryCompanies(nodes);
  const names = useMemo(() => new Map(nodes.map((n) => [n.id, n.legalName])), [nodes]);
  const [admins, setAdmins] = useState<UserSummaryDTO[]>([]);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [language, setLanguage] = useState<Locale>(locale);
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setAdmins((await everyUser()).filter((u) => u.role === "super_admin")), []);
  useEffect(() => {
    load().catch(showError);
  }, [load, showError]);

  async function invite() {
    setBusy(true);
    try {
      const created = await api.inviteUser(
        invitePayload({
          email, fullName, role: "super_admin", language,
          drafts: { super_admin: ticked.map((subsidiaryId) => ({ subsidiaryId, categories: [] })) },
        }),
      );
      if (created.invitation?.status === "sent") toast.success(t("superAdmins.invited", { email: created.email }));
      else toast.warning(t("superAdmins.invitedNotDelivered", { email: created.email }));
      setEmail("");
      setFullName("");
      setTicked([]);
      await load();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("superAdmins.description")}</p>
      <div className="space-y-3 rounded-md border p-3" data-testid="onboarding-invite">
        <div className="grid grid-cols-2 gap-3">
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder={t("superAdmins.fullName")} aria-label={t("superAdmins.fullName")} />
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("superAdmins.email")} aria-label={t("superAdmins.email")} />
        </div>
        <div className="flex gap-3 text-sm">
          {SUPPORTED_LOCALES.map((l) => (
            <label key={l} className="flex items-center gap-1">
              <input type="radio" name="onboarding-language" checked={language === l} onChange={() => setLanguage(l)} />
              {t(`superAdmins.languages.${l}`)}
            </label>
          ))}
        </div>
        <p className="text-xs font-medium">{t("superAdmins.companies")}</p>
        <div className="grid gap-1.5">
          {companies.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={ticked.includes(c.id)}
                onCheckedChange={(v) => setTicked((list) => (v === true ? [...list, c.id] : list.filter((id) => id !== c.id)))}
              />
              {c.legalName}
            </label>
          ))}
        </div>
        {/* One or more companies per invitation (§7.1 step 6; owner review of WP8, P2). */}
        <Button disabled={busy || !email.trim() || !fullName.trim() || ticked.length === 0} onClick={() => void invite()} data-testid="onboarding-invite-submit">
          {t("superAdmins.invite")}
        </Button>
      </div>
      <NodeList title={t("superAdmins.list")} empty={t("superAdmins.none")} names={admins.map((a) =>
          t("superAdmins.row", {
            name: a.fullName,
            email: a.email,
            companies: a.access.map((g) => names.get(g.subsidiaryId) ?? "—").join(", ") || "—",
            status: tUsers(`status.${a.status}`),
          }),
        )} testId="onboarding-admin-list" />
      {footer({ onClick: onNext })}
    </div>
  );
}

export function CentralReporterStep({ nodes, onNext, footer }: StepProps) {
  const t = useTranslations("onboarding");
  const showError = useErrorToast();
  const [users, setUsers] = useState<UserSummaryDTO[] | null>(null);
  const [target, setTarget] = useState<UserSummaryDTO | null>(null);
  const names = useMemo(() => new Map(nodes.map((n) => [n.id, n.legalName])), [nodes]);
  useEffect(() => {
    // Only a standard user with one main company can take the grant (B2; owner review of WP8, P2).
    everyUser().then((all) => setUsers(grantCandidates(all)), showError);
  }, [showError]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("centralReporter.description")}</p>
      {users !== null && users.length === 0 ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground" data-testid="onboarding-no-reporter">{t("centralReporter.noUser")}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="onboarding-reporter-list">
          {(users ?? []).map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 p-2 text-sm">
              <span>{u.fullName}</span>
              <Button size="sm" variant="outline" onClick={() => setTarget(u)}>
                {t("centralReporter.give")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <CentralReporterDialog
        target={target}
        companies={nodes}
        names={names}
        onClose={() => setTarget(null)}
        onSaved={(updated) => {
          setUsers((list) => (list ?? []).map((u) => (u.id === updated.id ? updated : u)));
          setTarget(null);
        }}
      />
      {footer({ label: t("skip"), onClick: onNext })}
    </div>
  );
}

function NodeList({ title, empty, names, testId }: { title: string; empty: string; names: string[]; testId: string }) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="list-inside list-disc text-sm">
          {names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
