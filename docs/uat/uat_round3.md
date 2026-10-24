# TonyAI — UAT Round 3: Test Catalogue for the Pilot Candidate

> **Purpose:** the single document for the third UAT round. It covers the pilot
> candidate build: four roles × two tenants × Turkish and English, with an explicit
> expected outcome for every journey.
> **Version:** 2026-10-25 · candidate = LP4-04 slice 2 PR C (`feat/lp4-04-localise-admin`)
> on `main` @ `5e192a9`. **Write down the SHA you test** at the top of your sign-off (§11).
> **Scope under test:** pilot scope. Scope 1 & 2 on UK and Türkiye geographies, Turkish
> and English UI, and two emails (invitation, password reset). Local environment only.
> **Supersedes** [`uat_round2.md`](uat_round2.md) for this build. Round-2 cases that are
> not repeated here still describe their screens, but the screens now have Turkish text too.
>
> **Emission factors on this build are placeholders.** Every tonnage comes from the
> prototype demo factor library, which the app labels: EN *"prototype demo emission factors —
> not authoritative DEFRA/AIB values"*, TR *"prototip demo emisyon faktörleri — yetkili
> DEFRA/AIB değerleri değildir"*. **No figure in this round is an acceptance value.**
> Authoritative UK/TR factor releases come with LP4-02 PR C, which has not shipped. Every case
> that depends on them is marked **Waits on LP4-02 PR C — do not accept**. Leave its P/F
> empty, or write "blocked".

---

## 1. What is different this round

| | What changed | Why it matters to you |
| --- | --- | --- |
| **Turkish and English everywhere a pilot user goes** | Every screen, toast and refusal has both languages. The switcher is at the bottom of the sidebar (**Language / Dil**), and the choice is saved **on your account**. | Every journey in §5 is run once in each language. |
| **Refusals now carry codes** | The API names *why* it refused something: a missing subsidiary, a locked period, a file the importer cannot read. The screen prints that code's own sentence in your language. | A Turkish user now reads a sentence that fits the case, not one generic sentence. |
| **A fourth role: executive viewer** | `viewer@tonyai.local`. It can read the whole organisation and cannot write anything. | Round 2 left this role out. It is in every matrix now. |
| **A second tenant, made the way a customer would be** | The operator command provisions a new organisation and its first administrator, who gets an emailed invitation (§4). | Tenant isolation is tested between two real organisations, not just between one user's subsidiaries. |
| **Accounts start from email** | Invitations and password resets go out by email. Locally they land in **mailpit**. | Round 2 used seeded accounts only. |
| **Inventory boundary and issued reports** | `/inventory-boundary` declares what a year's inventory covers. **Reports → Issued reports** captures a dataset and issues a retained PDF, workbook and CSV. | A *live preview* and an *issued report* are now separate things, and the UI keeps them apart. |
| **Turkish numbers** | Form fields take Turkish `1.234,5`. A bulk-file dry run shows the quantity it read from every row. Changing the language never changes a stored quantity. | A ×1000 misreading is the worst error this product can make. |
| **Shared evidence** | One file can back several records. It cannot be deleted while any record it backs can no longer change. | A file that backs a locked figure can no longer disappear. |

---

## 2. Environment & access

| | |
| --- | --- |
| Prerequisites | Docker Desktop running · Node ≥ 22.12 · pnpm |
| After pulling | `pnpm setup` (not just `pnpm install`). It writes the API's env, including the mail settings and the local-only placeholder-factor flag. |
| Fresh data | `pnpm db:reset` before you start. **It deletes Tenant B too** (§4.4). |
| Start | `pnpm dev`: web **http://localhost:3000**, API **http://localhost:3001/api/v1** |
| Mail catcher | **mailpit: http://127.0.0.1:54324**. Every invitation and reset email sent locally lands here. Nothing leaves your machine. |
| Data handling | Synthetic data only: never real people's addresses or real company data. When your participation ends, wipe the local database or delete the clone. |

### 2.1 Tenant A: seed users (password `TonyAI!2026`)

| User | Role (EN · TR label) | Sees in Tenant A |
| --- | --- | --- |
| `admin@tonyai.local` (Tony Admin) | super_admin · *Super admin · Süper yönetici* | all 5 subsidiaries; the only role that writes org structure, approves, withdraws, locks, reads `/audit`, manages `/users` |
| `approver@tonyai.local` (Arda Approver) | super_admin | the same. Use this account to approve what `admin@` entered, because nobody approves their own record. |
| `entry@tonyai.local` (Eda Entry) | data_entry · *Data entry · Veri girişi* | **TonyAI Energy** and **TonyAI Logistics** only |
| `review@tonyai.local` (Cem Consultant) | consultant · *Consultant · Danışman* | whole organisation; take into review and reject, never approve or enter |
| `viewer@tonyai.local` (Vera Viewer) | executive_viewer · *Executive viewer · Yönetici izleyici* | whole organisation, read only. **New this round.** |

**Language is per account, not per browser.** If two testers use the same seed account,
each one's language switch also changes it for the other. Give each tester their own
accounts, or agree who uses which language when.

### 2.2 Baseline after `pnpm db:reset`: check before testing

These are **counts**, which the seed fixes. Tonnages are placeholder outputs: write down what
you see, but do not judge them.

| What | Expected |
| --- | --- |
| Dashboard **Companies / Şirketler** · **Locations / Konumlar** | admin, consultant and viewer: **5 · 8** · entry: **2 · 4** |
| Activity records | **96**, all `approved`, reporting year **2026**; 6 of them filed against a site |
| Review queue · withdrawn records · period locks · boundary versions · issued reports | all **empty / none** |
| TonyAI Energy · Electricity cell (dashboard) | **`3/24`** |
| Banner on `/emissions` and `/reports` | the placeholder-factor wording quoted at the top of this document |

If a count is wrong, stop and report it before going further. A stale database is the most
likely reason a case "fails".

---

## 3. Round-1 close-out: the 16 items on this build

Statuses are refreshed from round 2 §3. Do the check and mark it. A failure is a round-3
finding: quote the round-1 ID.

| ID | Round-1 ask | Round 2 | **This build** | How to verify (EN · TR) | P/F |
| --- | --- | --- | --- | --- | --- |
| SUB-1 | Subsidiaries editable | ✅ | ✅ closed | `/subsidiaries` → pencil (**Open subsidiary · Bağlı şirketi aç**) → change legal name → **Save changes · Değişiklikleri kaydet** → toast *Subsidiary settings updated successfully. · Bağlı şirket ayarları güncellendi.* | |
| SUB-2 | Super-admin control panel | ✅ | ✅ closed | Same page: **Details · Ayrıntılar**, **Reporting contact · Raporlama irtibatı**, **Operational locations · Operasyonel lokasyonlar**, **What depends on this subsidiary · Bu bağlı şirkete bağlı olanlar**. As a non-admin the page reads *Bu bağlı şirketi görüntüleyebilirsiniz, ancak yalnızca bir süper yönetici değiştirebilir.* | |
| SUB-3 | Multiple locations + Google Places | ⚠️ half | ⚠️ **half closed (unchanged)** | **Add Subsidiary · Bağlı Şirket Ekle** asks for several locations and refuses to create without one. Google Places autofill is **not built**, and the product decision is still open. Tell us whether that blocks the pilot. | |
| DE-1 | Long names overlap location | ✅ | ✅ closed | Create a subsidiary with a very long legal name, then select it in Data Entry. It truncates within its own column, in both languages. | |
| DE-2 | Stay amber until all in | ✅ | ✅ closed | Round 2 GATE-01→04. A cell is green only when every entry in it is accepted. LP4-03 renamed the dashboard figure to *% data entry progress · %… veri girişi ilerlemesi*. Coverage against the boundary is now a separate card (§7.4). | |
| DE-3 | "Standard cubic metres" | ✅ | ✅ unit offered · **calculation: Waits on LP4-02 PR C — do not accept** | Natural Gas → unit **Standard cubic metres — Sm³ · Standart metreküp — Sm³** is listed. Picking it refuses the calculation, because a sourced calorific value is missing (*Standart metreküpün kWh'ye çevrilmesi için kaynağı belli bir ısıl değer gerekir…*). | |
| DE-4 | Refrigerants scope | ⏳ | ⏳ **Waits on LP4-02 PR C — do not accept** | The typed form exists: Refrigerants asks for a gas (R-32 … R-1234yf). With no gas chosen, the refusal reads *Choose the fuel or gas for this category. · Bu kategori için yakıt ya da gaz türünü seçin.* No authoritative refrigerant factor is loaded, so a result is a refusal (`no_factor` / `placeholder_refused`), never a figure. | |
| DE-5 | Mobile combustion + on/off-road | ⏳ | ⏳ **Waits on LP4-02 PR C — do not accept** | Fuel offers **Diesel · Dizel** and **Gas oil (red diesel) · Gas oil (kırmızı dizel, yol dışı kullanım)** as different types. In one month and slot they stay two distinct rows in a bulk dry run (round 2 TYPE-01). Mobile Combustion asks for a type. The factor coverage is not loaded. | |
| DE-6 | Turkey grid region | ✅ | ✅ region · **TR grid factor value: Waits on LP4-02 PR C — do not accept** | Data Entry shows a factor-geography line (`TR — Türkiye …`) and no grid picker. The TR factor behind it is a placeholder. | |
| DE-7 | UK + Turkey only | ✅ | ✅ closed | Geography choices are **United Kingdom (UK)** and **Türkiye (TR)**. TonyAI Mfg keeps its stored **EU** and does not blank on save. | |
| DE-8 | Turkish characters in evidence | ✅ | ✅ closed | Upload `Şubat-Faturası-İĞÜÖÇ.pdf`. The name stays intact in the vault, on download and in `/review`, in both UI languages. | |
| DE-9 | Reporting years | ✅ (2015–2026) | ✅ selection · **factor years: Waits on LP4-02 PR C — do not accept** | Years now run **2100 → 2000** (newest first, default 2026). The same list appears on Data Entry, the period-lock drawer and the reporting-context bar. Factors exist for 2026 only, so another year answers *No emission factor covers this category… yet. · …henüz bir emisyon faktörü yok.* | |
| DASH-1 | Locations count live | ✅ | ✅ closed | Add a location in a second tab, then return to the dashboard: **Locations · Konumlar** updates when the tab regains focus. | |
| DASH-2 | Boxes clickable | ✅ | ✅ closed | Click a coloured matrix cell → Data Entry opens with that subsidiary, category and year selected. | |
| DASH-3 | Per-location completeness | ✅ | ✅ closed | TonyAI Energy's cells show fractions (`3/24`). Its drawer shows the per-site, per-month grid with Turkish month names in TR. | |
| EM-1 | Sales output + gas units | ✅ | ✅ closed | `/emissions` → **Intensity · Yoğunluk** → **Sales output · Satış çıktısı** (MWh). | |

**Tally:** 10 closed · 3 closed in the UI with their factor-dependent part waiting on LP4-02
PR C (DE-3, DE-6, DE-9) · 1 half closed (SUB-3) · 2 waiting on LP4-02 PR C (DE-4, DE-5).
**Do not mark DE-3's calculation, DE-4, DE-5, DE-6's factor or DE-9's other years accepted.**

---

## 4. Tenant B: provisioning a second organisation

The seed has one organisation. In this build a new tenant is created **only** by the operator
command (`apps/api/src/onboarding/onboarding.cli.ts`, decision D18). No screen or HTTP route
creates an organisation. The new tenant's first super_admin then invites everyone else from
`/users`.

### 4.1 The operator step (run from the repository root)

```bash
set -a; source apps/api/.env; set +a      # DIRECT_URL, SUPABASE_*, SMTP_HOST, MAIL_FROM, APP_URL
pnpm onboarding provision --operator=uat-operator@tonyai.local \
  --legal-name="Anadolu Holding A.Ş." --trading-name="Anadolu Holding" \
  --country=TR --geography-code=TR --currency=TRY \
  --admin-email=b.admin@tenant-b.local --admin-name="Burak Admin" --language=tr
# prints a JSON plan and writes nothing; re-run the same line with --apply to provision
```

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| TB-01 | Run the command **without** `--apply` | JSON plan, exit 0, nothing written: no organisation appears and mailpit is empty | |
| TB-02 | Re-run with `--apply` | JSON report showing the invitation delivered; exit **0** (exit 1 means an invitation or Auth step still needs a person) | |
| TB-03 | Provision again with `--admin-email=admin@tonyai.local` | Refused with exit 2: *That address already belongs to another organisation (D17: one organisation per account).* | |
| TB-04 | Run TB-02's line again, before the invitation is accepted | A **fresh** invitation is sent and the first link stops working (MAIL-04) | |

### 4.2 First administrator and the rest of Tenant B

1. mailpit → the Turkish invitation (MAIL-01) → **Daveti kabul et** → `/auth/confirm` →
   **Devam et** → `/auth/set-password` → a password of **≥ 12 characters** (suggested
   `TenantB-UAT-2026!`) → **Şifreyi kaydet**. You are signed in, in Turkish.
2. As `b.admin`: `/subsidiaries` → **Bağlı Şirket Ekle**, twice:
   **Anadolu Enerji A.Ş.** (TR, location *Bursa Fabrikası*, TR) and **Thames Logistics Ltd**
   (UK, location *Leeds Hub*, UK).
3. `/users` → **Kullanıcı davet et** for each of these. Mixing the email languages
   exercises both email catalogues.

| Address | Role | Email language | Subsidiaries |
| --- | --- | --- | --- |
| `b.approver@tenant-b.local` | Super admin | English | (whole organisation) |
| `b.entry@tenant-b.local` | Data entry | Turkish | **Anadolu Enerji A.Ş. only** |
| `b.review@tenant-b.local` | Consultant | English | (whole organisation) |
| `b.viewer@tenant-b.local` | Executive viewer | Turkish | (whole organisation) |

Accept each invitation from mailpit. Then, as `b.entry`, create and submit a record for
Anadolu Enerji; as `b.admin`, create and submit one for Thames Logistics. Approve each as a
super_admin who did not enter it (`b.admin` approves `b.entry`'s, `b.approver` approves
`b.admin`'s). Tenant B now has approved data of its own.

### 4.3 Operator audit trail

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| TB-05 | As `b.admin`: `/audit` | Tenant B's own rows only. The provisioning rows show the actor as **sistem / system** *(to confirm: that the operator's rows appear in Tenant B's trail)* | |
| TB-06 | As `admin@tonyai.local`: `/audit` | None of Tenant B's rows | |

### 4.4 After a reset

`pnpm db:reset` drops Tenant B's organisation and profiles, but **not** the Supabase Auth
users. *(To confirm:)* re-provisioning with the same addresses is then expected to fail at the
Auth step (`email_unavailable`). After a reset, provision Tenant B with **new addresses**, for
example `b2.admin@tenant-b.local`.

---

## 5. Role × tenant × language matrix

Run every row four times: **Tenant A in EN, Tenant A in TR, Tenant B in EN, Tenant B in
TR**. Switch with **Language · Dil** in the sidebar. Tenant A users are the seed accounts.
Tenant B users are the `b.*` accounts. Data-entry rows in Tenant B use **Anadolu Enerji** in
place of Energy/Logistics.

"**Absent**" means the control is not on the screen. "**Refused**" means the control is
there, and the API answers with the quoted sentence. Every sidebar item is shown to every
role. A screen a role may not use explains why on the screen; it does not hide.

### 5.1 super_admin: `admin@` / `b.admin`

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| ADM-01 | Sign in, read the sidebar and the page header | Nine items. EN: Dashboard, Data Entry, Subsidiaries, Emissions, Review Queue, Reports, Inventory Boundary, Audit Trail, Users. TR: Gösterge Paneli, Veri Girişi, Bağlı Şirketler, Emisyonlar, İnceleme Kuyruğu, Raporlar, Envanter Sınırı, Denetim İzi, Kullanıcılar. Header: name, *Süper yönetici*, **Çıkış yap / Sign out** | | | | |
| ADM-02 | `/subsidiaries` | **Add Subsidiary · Bağlı Şirket Ekle** present. Pencil and bin on every row. A lists 5 subsidiaries; B lists its 2 | | | | |
| ADM-03 | Create a subsidiary with one location | Toast *Subsidiary created · Bağlı şirket oluşturuldu*. Without a location: *Add at least one operational location* | | | | |
| ADM-04 | Delete **TonyAI Energy** (A) or a subsidiary holding approved records (B) | Refused. TR toast *Bu bağlı şirkete bağlı veriler varken şirket silinemez — "Bu bağlı şirkete bağlı olanlar" bölümüne bakın.* with the server's English list of dependents beneath it. The row is still there | | | | |
| ADM-05 | Delete the subsidiary from ADM-03 | Toast *Subsidiary deleted · Bağlı şirket silindi* | | | | |
| ADM-06 | `/review` → open a record **you entered** | **Approve · Onayla** absent. *You cannot approve a record you entered. · Kendi girdiğiniz bir kaydı onaylayamazsınız.* Approve it as the other super_admin | | | | |
| ADM-07 | `/review` → approve one entered by data_entry | Toast *Record approved · Kayıt onaylandı*; the row leaves the queue | | | | |
| ADM-08 | `/audit` after ADM-03…07 | Columns *Zaman · Yapan · O andaki rol · İşlem · Varlık · Değişiklik*. Your changes are the newest rows. Action and entity are raw codes in both languages (M2, §9) | | | | |
| ADM-09 | `/users` → your own row → API `POST /users/<your id>/disable` | Refused 403 `own_account_forbidden`: *Kendi rolünüzü değiştiremez veya kendi hesabınızı devre dışı bırakamazsınız; başka bir süper yöneticiden isteyin.* | | | | |
| ADM-10 | `/emissions` → **History · Geçmiş** → an approved record | **Withdraw this figure · Bu rakamı geri çek** present (round 2 §4.4 applies in full) | | | | |
| ADM-11 | `/emissions` → **Targets · Hedefler** | **Add target · Hedef ekle** present | | | | |
| ADM-12 | `/reports` → live preview | **Download PDF · PDF indir**, **Export Excel · Excel'e aktar**, **Export CSV · CSV'ye aktar** | | | | |

### 5.2 data_entry: `entry@` / `b.entry`

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| ENT-01 | Dashboard, `/subsidiaries`, Data Entry's subsidiary list, `/reports` | Exactly the granted subsidiaries: A **TonyAI Energy + TonyAI Logistics**; B **Anadolu Enerji** only. No other subsidiary's name or figures anywhere | | | | |
| ENT-02 | `/subsidiaries` | **Add Subsidiary** absent. Pencil and bin absent. The locations drawer reads *Lokasyonları yalnızca bir süper yönetici ekleyebilir veya değiştirebilir.* The locks drawer reads *Raporlama dönemlerini yalnızca bir süper yönetici kilitleyebilir veya açabilir.* | | | | |
| ENT-03 | Type `/subsidiaries/<id of a NON-granted subsidiary of the same tenant>` (A: `22222222-2222-2222-2222-222222220002`) | The not-found page: *Subsidiary not found · Bağlı şirket bulunamadı* / *Bu bağlı şirket yok ya da artık ona erişiminiz yok.* Identical to `/subsidiaries/00000000-0000-4000-8000-000000000000` | | | | |
| ENT-04 | Data Entry → create a draft, attach a file, **Submit for review · İncelemeye gönder** | *Draft saved · Taslak kaydedildi*, then *Submitted for review · İncelemeye gönderildi* | | | | |
| ENT-05 | `/review` | Gate card: *Reviewing is done by a consultant or a super_admin · İncelemeyi bir danışman veya süper yönetici yapar*, with *Rolünüz:* `data_entry`. No queue is shown | | | | |
| ENT-06 | `/audit` | *Only a super_admin can read the audit trail · Denetim izini yalnızca bir süper yönetici okuyabilir* | | | | |
| ENT-07 | `/users` | *Only a super admin manages users · Kullanıcıları yalnızca süper yöneticiler yönetir* … *Rolünüz: Veri girişi.* | | | | |
| ENT-08 | `/reports` | Live preview of the granted subsidiaries. No export buttons, and the note *Your role can view report data but cannot generate or export reports. · Rolünüz rapor verilerini görebilir ancak rapor oluşturamaz veya dışa aktaramaz.* **Issued reports** tab: *Rolünüz kesinleştirilmiş raporları okumaz.* | | | | |
| ENT-09 | `/inventory-boundary` | Read only: *Bir sınırı yalnızca bir süper yönetici beyan edebilir…* plus *Yalnızca erişiminiz olan bağlı şirketleri görüyorsunuz…* | | | | |
| ENT-10 | API: `PATCH /api/v1/subsidiaries/<granted id>` with `{"legalName":"x"}` | **403**, code `forbidden` (a role-only refusal stays generic). Nothing changes | | | | |
| ENT-11 | A record entered by someone else (as `admin@`, in a granted subsidiary) → open it in Data Entry | The evidence vault reads *Entered by someone else. · Başka biri tarafından girildi.* An edit is refused | | | | |

### 5.3 consultant: `review@` / `b.review`

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| CON-01 | Dashboard, `/subsidiaries`, `/emissions` | Whole organisation (A 5, B 2), read only. No write controls on Subsidiaries. Withdraw absent. **Add target** absent, with *Azaltım hedeflerini bir super_admin tanımlayabilir.* | | | | |
| CON-02 | `/review` → a submitted record | **Start review · İncelemeye al** and **Reject · Reddet** present. **Approve** absent, with *Onay süper yöneticiye ayrılmıştır — danışman olarak bir kaydı incelemeye alabilir veya geri gönderebilirsiniz.* | | | | |
| CON-03 | Reject with a reason | Reject needs a reason (*Gerekçe (reddetmek için zorunlu)*). Toast *Kayıt reddedildi — gerekçe artık gönderen tarafından görülebiliyor* | | | | |
| CON-04 | Data Entry | The **Bulk upload · Toplu yükleme** card is absent. The evidence vault reads *Rolünüz kanıt ekleyemez.* **Save draft** is refused: *Your role may not create activity records. · Rolünüz faaliyet kaydı oluşturamaz.* | | | | |
| CON-05 | `/reports` live | Generate and export allowed | | | | |
| CON-06 | `/reports` → Issued, when the year's newest boundary version is still open | Capture is not offered for it: *Yılın en yeni sınır sürümü hâlâ açık: onu önce bir super_admin yakalayarak dondurur.* Once a super_admin has frozen it (§7.5), the consultant may capture and issue a **partial** report | | | | |
| CON-07 | `/audit`, `/users`, `/inventory-boundary` | ENT-06/ENT-07 wording (role `consultant` / *Danışman*). The boundary is read only | | | | |

### 5.4 executive_viewer: `viewer@` / `b.viewer`

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| VIE-01 | Dashboard, `/emissions` (all tabs), `/subsidiaries/<id>` | Whole organisation, read only. The subsidiary page reads *Bu bağlı şirketi görüntüleyebilirsiniz, ancak yalnızca bir süper yönetici değiştirebilir.* Withdraw and **Add target** absent | | | | |
| VIE-02 | `/review` | The gate card from ENT-05, with role `executive_viewer` | | | | |
| VIE-03 | Data Entry → **Save draft** | Bulk upload card absent. Refused: *Rolünüz faaliyet kaydı oluşturamaz.* | | | | |
| VIE-04 | `/reports` live | Generate and export **allowed** (only data_entry is refused). See judgement ask §10.4 | | | | |
| VIE-05 | `/reports` → Issued | Lists and downloads issued reports. *Rolünüz kesinleştirilmiş raporları okur; yakalamaz veya kesinleştirmez.* No Capture, Check or Issue | | | | |
| VIE-06 | `/audit`, `/users`, `/inventory-boundary` | Refusal cards as ENT-06/ENT-07 (*Yönetici izleyici*). The boundary is read only | | | | |
| VIE-07 | API with the viewer's token, each with a **valid** body (copy one an admin would send — the role check runs after validation, so `{}` answers 400 `validation_failed`): `POST /activity-records`, `POST /subsidiaries`, `POST /report-datasets` | **403** each (`record_create_forbidden`, then `forbidden` twice). No record, subsidiary or dataset is written | | | | |

### 5.5 Cross-tenant isolation (Tenant B ↔ Tenant A)

To get API tokens: `POST http://127.0.0.1:54321/auth/v1/token?grant_type=password`, with header
`apikey: <NEXT_PUBLIC_SUPABASE_ANON_KEY from apps/web/.env.local>` and body
`{"email":…,"password":…}`. Then use `Authorization: Bearer <access_token>`. Keep tokens out of
saved evidence. Take Tenant A ids from the seed (subsidiary `22222222-2222-2222-2222-222222220001`,
location `33333333-3333-3333-3333-333333330001`), or from `admin@`'s own API reads (a record, its
evidence, an issuance after §7.5).

| ID | Steps (as a Tenant B user unless stated) | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| ISO-01 | `b.admin`, `b.review`, `b.viewer`: dashboard, Subsidiaries, Emissions, Reports, Boundary, Audit, Users | Only Tenant B's subsidiaries, people and figures. Not one TonyAI name | | |
| ISO-02 | Browser: `/subsidiaries/22222222-2222-2222-2222-222222220001` vs `/subsidiaries/00000000-0000-4000-8000-000000000000` | The same not-found page for both (*Bağlı şirket bulunamadı*) | | |
| ISO-03 | API `GET /subsidiaries/<A id>` vs the random UUID; repeat for `/locations/<A location>`, `/activity-records/<A record>`, `/evidence/<A evidence>/url`, `/report-issuances/<A issuance>`, `/inventory-boundaries/<A version>` | **404** with **byte-identical bodies** for the foreign and the random id: `subsidiary_not_found`, `location_not_found`, `record_not_found`, `evidence_not_found`, `report_issuance_not_found`, `boundary_not_found`. A foreign id never answers 403 | | |
| ISO-04 | API `GET /subsidiaries/abc` | **400** `invalid_id` (*Bu bağlantı ya da kimlik geçerli değil.*) | | |
| ISO-05 | `b.admin` → `/users` → invite `entry@tonyai.local` | Refused: *This email address already has an account. · Bu e-posta adresinin zaten bir hesabı var.* The response does not say which organisation holds it | | |
| ISO-06 | `b.admin` API: invite a data_entry with `subsidiaryIds:[<A id>]`; `PATCH /users/<A user id>/role` | **404** `subsidiary_not_found`, then **404** `user_not_found`. Nothing written | | |
| ISO-07 | `b.entry` → Data Entry → **Download template** → its Reference sheet; then upload a row naming an A subsidiary id | The Reference sheet lists Anadolu Enerji and its site only. The foreign row is refused as *Unknown reporting entity · Bilinmeyen raporlama birimi* | | |
| ISO-08 | `admin@` (Tenant A): dashboard, `/audit`, `/users`, Reports totals | No Tenant B subsidiary, person, audit row or tonnage | | |

---

## 6. Emails (invitation and password reset)

The pilot sends **exactly two** kinds of email. Read them in mailpit (http://127.0.0.1:54324).

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| MAIL-01 | The operator invitation (TB-02, `--language=tr`) | Subject *TonyAI'da Anadolu Holding için davetiniz var*. Body *…Anadolu Holding hesabını ilk yönetici olarak kurmaya davet edildiniz.* Button **Daveti kabul et**. Expiry line *…1 saat sonra geçerliliğini yitirir. Süresi dolduysa TonyAI'dan yeni bir davet göndermesini isteyin.* | |
| MAIL-02 | An administrator's invitation in English (`b.approver`) | Subject *You're invited to Anadolu Holding on TonyAI*. Body names the inviter: *Burak Admin has invited you to join…* Button **Accept the invitation** | |
| MAIL-03 | A Turkish administrator invitation (`b.entry`) | *Merhaba …*, *Burak Admin, sizi … davet etti.* Turkish characters intact in the subject, the body and the sender name | |
| MAIL-04 | Open an invitation link → **Continue** → set a password. Then open the **same** link again, and also an older link replaced by a re-send | First time: *Accept your invitation · Davetinizi kabul edin* → *Choose your password · Şifrenizi belirleyin*. 11 characters are refused (*En az 12 karakter kullanın.*); a mismatch reads *İki şifre birbiriyle eşleşmiyor.* Reused or replaced link: *This link no longer works · Bu bağlantı artık çalışmıyor* — *…Yöneticinizden yeni bir davet göndermesini isteyin.* | |
| MAIL-05 | After accepting, sign in | The UI opens in the **language the invitation was sent in**: the profile language is taken from the invitation | |
| MAIL-06 | `/users` → **Re-send invitation · Daveti yeniden gönder** on an invited user; then on an accepted one (API) | The first gets *Invitation re-sent to … · Davet … adresine yeniden gönderildi*. The accepted one is refused 409 `invitation_closed` (*Bu davet zaten kabul edildi.*). A seed account answers 404 `invitation_not_found` | |
| MAIL-07 | `/login` → **Forgot your password? · Şifrenizi mi unuttunuz?** for a **Tenant B** account whose language is TR, then for one whose language is EN | The same *Check your email · E-postanızı kontrol edin* screen for both. Subjects *TonyAI şifrenizi sıfırlayın* / *Reset your TonyAI password*. **The email follows the account's saved language, not the language of the page that requested it.** Use Tenant B accounts: a reset of a seed account changes its shared password | |
| MAIL-08 | Reset an unknown address; reset the same real address twice within 5 minutes | The same confirmation screen each time. No email for the unknown address, and only **one** email for the double request | |
| MAIL-09 | `b.admin` disables `b.viewer` (**Hesabı devre dışı bırak**), then `b.viewer` requests a reset and signs in | No reset email. The next request or sign-in reads *Hesabınız devre dışı bırakıldı…*. After **Hesabı etkinleştir**, the toast tells the admin the person must choose a new password via *Şifrenizi mi unuttunuz?* | |
| MAIL-10 | Submit, approve, reject and lock anything | **No** email is sent: workflow notifications are post-pilot | |

---

## 7. Feature cases

### 7.1 Bulk upload (data_entry or super_admin; Tenant A and B)

Imports allow **5 requests per minute per user**, and a dry run counts. A 429 *Çok fazla içe
aktarma denemesi yapıldı…* is not a result: wait a minute and repeat. Start from **Download
template · Şablonu indir**. Use free 2026 slots (for example Logistics or Anadolu Enerji ·
Natural Gas · Quarterly).

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| BLK-01 | CSV, `activityValue` = `1.234` | The dry run lists the row under **Accepted rows · Kabul edilen satırlar** with **Amount read · Okunan miktar** = EN `1.234 kWh`, TR `1,234 kWh`, under the note that a file always uses a point for decimals (*…dosyadaki 1.234, 1,234 olarak okunur (bin iki yüz otuz dört değil)…*) | | |
| BLK-02 | XLSX with a **numeric** cell 1234.5 (Excel in Turkish shows `1234,5`) | Read as the number: EN `1,234.5 kWh`, TR `1.234,5 kWh` | | |
| BLK-03 | CSV, quoted `"1.234,5"` and `"1,5"`; XLSX **text** cells `1.234,5` and `1,5` | Each row is refused under *Comma in a number · Sayıda virgül var*, with the per-row sentence in English (K5): *"1.234,5" uses a comma. Write the figure with a point for decimals…* Nothing is imported | | |
| BLK-04 | A clean file → **Import · İçe aktar** → confirm | *N records imported as drafts…* / *N kayıt taslak olarak içe aktarıldı…*. The rows appear under **Recent imports · Son içe aktarmalar** with **Send N drafts for review · N taslağı incelemeye gönder**. Each amount is the same as the dry run showed | | |
| BLK-05 | Pick a `.txt` file in the panel; then send it straight to the API (`POST /bulk-upload/activity-records`) | The panel refuses before upload: *Bir .csv veya .xlsx dosyası yükleyin.* The API answers 400 `bulk_file_type` (*Upload a .csv or .xlsx file.*) | | |
| BLK-06 | CSV with **1,001** data rows | *The file has 1,001 rows; the limit is 1,000. Split it and upload the parts.* · *Dosyada 1.001 satır var; sınır 1.000. Dosyayı bölüp parçaları yükleyin.* (the counts are grouped per language) | | |
| BLK-07 | CSV saved as Windows-1254 (Turkish ANSI) with `ş/ğ` in a cell | `bulk_file_encoding`: *Dosya UTF-8 metin değil. Excel'de "CSV UTF-8 (Virgülle ayrılmış)" olarak kaydedip yeniden yükleyin.* | | |
| BLK-08 | A header-only CSV; a text file renamed `.xlsx` | `bulk_no_rows` *Dosyada veri satırı yok.*; `bulk_workbook_unreadable` *Dosya bir çalışma kitabı olarak okunamadı.* | | |
| BLK-09 | Fuel rows with `diesel` and `gas_oil` in one month and slot | **Waits on LP4-02 PR C — do not accept.** Today the rows stay distinct in the dry run; an import is refused per row (`no_factor` / placeholder) or computed on placeholders, which is not authoritative | | |

### 7.2 Shared evidence (data_entry creates; super_admin approves and locks)

Tenant A: TonyAI Logistics · Natural Gas · 2026 · **Quarterly**. Tenant B: Anadolu Enerji, the
same slots.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| EVI-01 | As entry: save drafts for **Q1** and **Q2** → **Previous submissions · Önceki gönderimler** → **Attach one file to several records · Tek dosyayı birden fazla kayda ekle** → tick both → choose a PDF → **Attach · Ekle** | The confirmation names both records (*…tek bir dosya olarak bu 2 kayda eklenecek. İnceleyiciler dosyanın desteklediği her kaydı görür.*). Toast *… artık 2 kaydı destekliyor.* | | |
| EVI-02 | Open each record's evidence | The file is on both, with *Ayrıca 1 başka kaydı destekliyor: …*. The action reads **Remove from this record · Bu kayıttan kaldır** | | |
| EVI-03 | Submit Q1. As admin approve it, then `/subsidiaries` → **Manage period locks · Dönem kilitlerini yönet** → Quarterly · Q1 · 2026 → **Lock period · Dönemi kilitle** | *1. çeyrek 2026 kilitlendi — bu dönemdeki kayıtlar artık donduruldu*. Q1 reads **Locked · Kilitli**. Its vault is read only: *1. çeyrek 2026 kilitli.* | | |
| EVI-04 | As entry, API `DELETE /api/v1/evidence/<file id>` | **409** `evidence_backs_locked_records`. The screen wording is *Bu dosya artık değişemeyen 1 kaydı da destekliyor, bu yüzden silinemez…*. The file stays on both records | | |
| EVI-05 | On Q2 → **Bu kayıttan kaldır** | *Bu kayıttan kaldırıldı — … hâlâ 1 başka kaydı destekliyor.* Q1 keeps the file and can still download it | | |
| EVI-06 | Attach a file to Q2 again, submit it, then (admin) try to lock Quarterly · Q2 · 2026 before deciding it | Refused: *Bu dönemde 1 kayıt hâlâ inceleme bekliyor — kilitlemeden önce onaylayın veya reddedin.* | | |
| EVI-07 | Unlock (**Kilidi aç**) after the test | *1. çeyrek 2026 kilidi açıldı*. Q1 goes back to Approved | | |

### 7.3 Turkish numbers (any role that can enter data)

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| NUM-01 | TR, Data Entry, activity value `1.234,5` → **Taslağı kaydet** | The note under the field: *1234,5 olarak okundu.* The API's stored `activityValue` is **1234.5** | |
| NUM-02 | TR, type `1.234` | *1234 olarak okundu — 1,234 değil.* (the other reading is named before saving) | |
| NUM-03 | TR, type `1234.5` · EN, type `1,5` | TR refused: *Ondalık ayırıcı olarak virgül kullanın, örneğin 45000,5.* EN refused: *Use a point as the decimal separator, e.g. 45000.5.* Save is not possible | |
| NUM-04 | Reopen NUM-01's draft, switch to EN, then back to TR | The field shows `1234.5` in EN and `1234,5` in TR. The API value stays **1234.5** throughout. **A language switch never changes a stored quantity** | |
| NUM-05 | Additional context numeric fields (e.g. on a typed category), in TR | Accept `1.234,5` and save a number. Text that cannot be read refuses the save rather than being dropped | |
| NUM-06 | Dashboard and Emissions in TR, then EN | The same totals, grouped per language: a thousands figure reads `1.234` in TR and `1,234` in EN, a decimal `12,3` vs `12.3`. A trend's sign sits outside the percent sign in TR (`+%12,3`) | |
| NUM-07 | TR user: live **Excel'e aktar**; **CSV'ye aktar** | The workbook's figures are **numeric cells** (SUM works), with Turkish labels. The CSV keeps English machine headers and dot decimals | |
| NUM-08 | §7.1 BLK-01/02/03 | Bulk files are always dot-decimal, and the dry run shows what was read (cross-reference) | |

### 7.4 Inventory boundary editor (`/inventory-boundary`)

Use **2026** in Tenant A so that §7.5 has something to capture. In Tenant B use 2026 for its
own subsidiaries. A **confirmed or captured version never changes**, and only `db:reset`
removes it.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| BND-01 | admin → `/inventory-boundary?year=2026` | *2026 için beyan edilmiş bir sınır yok. Beyan etmek için bir sürüme başlayın.* → **Boş bir sürüm başlat** → *Sürüm 1 başlatıldı.* | | |
| BND-02 | **Beyan et** a subsidiary, then save without choosing an attribution or cadence | The save is refused on the fields themselves (*Kaydetmeden önce düzeltilecek sorunlar: N*). Nothing is defaulted for you | | |
| BND-03 | Complete and save it | *… kaydedildi.* or *Sürüm onaylanmadan önce giderilecek eksikler: N*. The row shows months, sites, sources and gaps | | |
| BND-04 | **Sürümü onayla** while it has gaps; then once it has none | Blocked: *Önce eksikleri giderin: N*. Once clean, the dialog names the undeclared subsidiaries (*Beyan edilmedikleri için envanterin dışında kalanlar: …*) → **Onayla** → *Sürüm 1 onaylandı.* and the version is read only | | |
| BND-05 | Edit a confirmed version through the API | 409 `boundary_frozen` (*…dondurulmuş, artık değiştirilemez. Değişiklik yapmak için onu yeni bir sürüme kopyalayın.*) | | |
| BND-06 | **Sürüm 1'den yeni sürüm** → then **Sürümü sil** on the copy | The copy opens. Delete asks *Sürüm 2 silinsin mi?* … *Bu geri alınamaz.* | | |
| BND-07 | consultant, viewer, data_entry | Read only (§5). data_entry sees only granted subsidiaries. When the version declares a subsidiary outside its grants, its coverage card says the coverage is not shown to it (*…erişiminiz dışındaki bir bağlı şirketi beyan ediyor…*) | | |

### 7.5 Issued reports (`/reports` → **Issued reports · Kesinleştirilmiş raporlar**)

**On this build every issued report is partial.** The figures are on placeholder factors, so
every dataset carries the gap *Figures not on an authoritative factor release · Yetkili bir
faktör sürümüne dayanmayan rakamlar*. That is the correct outcome, not a defect.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| ISS-01 | Live tab, any role that can read it | Banner *Canlı önizleme — kesinleştirilmiş bir rapor değildir…*. Badge *Tüm kayıtlar onaylı* is a review status, not a certification. Live downloads are named `tonyai-live-…` | | |
| ISS-02 | Issued tab before §7.4 | *2026 için beyan edilmiş bir envanter sınırı yok; bu yüzden yakalanacak bir şey yok.* | | |
| ISS-03 | admin → **Envanteri yakala** | *Veri seti yakalandı*. An open version becomes *Donduruldu, onaylanmadı* on `/inventory-boundary` | | |
| ISS-04 | **Kontrol et** on the dataset | *Kısmi — nihai raporu engelleyen eksikler: N.*, and the non-authoritative gap is listed | | |
| ISS-05 | **Kesinleştir** → template *Yönetici özeti*, **Rapor dili: Türkçe** | *Kısmi rapor kesinleştirildi*. The list shows *Kısmi*, *Eksikler: N*, the template and the language | | |
| ISS-06 | Download its **PDF / Excel / CSV** | The PDF and workbook are in Turkish. The CSV has English headers and dot decimals, and carries the issuance, dataset and fingerprint on every row. The three agree on totals | | |
| ISS-07 | Issue the same dataset in **English**; then try the same language, template and options again | A second issuance with an English PDF. The repeat is not created: `report_already_issued` (*…zaten kesinleştirildi. Bunun yerine PDF dosyasını indirin.*) | | |
| ISS-08 | Approve or withdraw a record, then re-download ISS-06's PDF | The issued files are **unchanged** (they are retained); the live preview has changed | | |
| ISS-09 | consultant / viewer / data_entry on this tab | §5: consultant issues partials only; viewer reads and downloads; data_entry *Rolünüz kesinleştirilmiş raporları okumaz.* | | |
| ISS-10 | A **final** report: *Nihai rapor olmaya uygun*, **Current final · Geçerli nihai rapor**, `report_final_forbidden` for a consultant | **Waits on LP4-02 PR C — do not accept.** Unreachable on placeholder factors | | |

### 7.6 Refusal wording in Turkish (spot checks)

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| ERR-01 | TR: lock a period, then (as entry) save a draft in it | the period named in Turkish, e.g. *1. çeyrek 2026 raporlama dönemi kilitli — içindeki bir şeyin değişebilmesi için bir süper yöneticinin kilidi açması gerekir.* | |
| ERR-02 | TR: create a second record in an occupied slot | *Bu raporlama birimi, dönem ve kategori için zaten bir faaliyet kaydı var.* | |
| ERR-03 | TR: delete a location holding records | *Bu lokasyonda N faaliyet kaydı var…* | |
| ERR-04 | TR: a role-only refusal (ENT-10 done from the UI where possible) | *Bu işlem için yetkiniz yok.* with the server's English sentence beneath it (K5) | |
| ERR-05 | TR: Natural Gas in Sm³ | A Turkish title, with the calculation's English reason beneath it (K5) | |

---

## 8. Recommended order

1. §2.2 baseline → §3 close-out (read-only parts first).
2. §4 Tenant B, which also exercises MAIL-01…06.
3. §5 matrix, first in EN and then in TR, per tenant.
4. §7.1, §7.2, §7.3. Then §7.4 before §7.5.
5. Last: anything that cannot be undone (withdrawals, confirmed versions, issuances), then MAIL-07…09.

---

## 9. Known limitations: do **not** report these as bugs

- **Placeholder factors (LP4-02 PR C not shipped).** Tonnages are not authoritative. Final
  reports cannot be issued. DE-3's Sm³, DE-4, DE-5, the TR/UK factor values and factor years
  other than 2026 wait on it.
- **K5: some English stays inside Turkish screens.** That covers a bulk file's per-row
  sentences, a calculation refusal's reason, the dependents named by `subsidiary_in_use`, and
  the server's sentence under a generic refusal (role-only 403s stay the generic *Bu işlem için
  yetkiniz yok.*). Each one sits beneath a Turkish title.
- **M2: audit action and entity codes are raw identifiers** in both languages. The review and
  audit gate cards print your role as its code (`data_entry`).
- **CSV files have English machine headers and dot decimals** in every language, live and
  issued, by design (D16). PDF and Excel follow the report language.
- **M10 (filed, not fixed):** an issued report can show the English *Not specified*, and some
  issued-catalogue categories in English.
- **Tenants are provisioned only by the operator command** (D18). There is no sign-up and no
  organisation screen.
- **Seed accounts have no invitation.** Re-send answers `invitation_not_found`.
- No screen sets a subsidiary's tracking mode. There is no bulk review, no Google Places, and
  no workflow email. Scope 3, suppliers and report sharing come after the pilot.
- A withdrawal, a confirmed or captured boundary version, and an issuance cannot be undone.
- Imports and exports allow 5 per minute per user. A 429 is a pause, not a result.

---

## 10. What we would most like your judgement on

1. **Turkish domain terms.** Do *kesinleştirme* (issue), *yakalama* (capture), *geri çekme*
   (withdraw) beside the status *Geçersiz kılındı*, *beyan* (declare) and *Envanter sınırı* read
   as a Turkish sustainability team would say them? (The owner's review sheet, M6. The external
   reviewer, D24, is still open.)
2. **English under Turkish (K5).** Is a Turkish title over the server's English detail
   acceptable for the pilot, or must specific refusals be fully Turkish first?
3. **"Partial" on every issued report.** While the factors are placeholders, is the
   non-authoritative gap clear enough that nobody would file one of these reports?
4. **Executive viewer exports.** It may generate and export live reports, but not capture or
   issue. Is that the right line?
5. **Raw role codes on the gate cards** (`data_entry` in *Rolünüz: …*): acceptable, or should
   they read *Veri girişi* as `/users` does?

---

## 11. Reporting an issue and sign-off

For each issue: **case ID**, **tenant (A/B)**, **language (EN/TR)**, **user**, **page**, numbered
steps, expected vs actual, a screenshot (and the console if something crashed), and severity:
**S1** blocks testing · **S2** wrong result, wrong data or an isolation leak · **S3** cosmetic.
A wrong number, a quantity changed by a language switch, or anything from another tenant is
**S2 at least**. Quote the round-1 ID for §3 items.

**Build SHA tested:** ____________ · **Date:** ____________

| super_admin | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.1 + §7.4 + §7.5 | | | | | | | |

| data_entry | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.2 + §7.1 + §7.2 + §7.3 | | | | | | | |

| consultant | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.3 | | | | | | | |

| executive_viewer | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.4 | | | | | | | |

| Cross-cutting | Tester | Date | Verdict (Pass / Pass w/ notes / Fail) |
| --- | --- | --- | --- |
| §3 round-1 close-out (excluding items waiting on LP4-02 PR C) | | | |
| §4 Tenant B provisioning + §5.5 isolation | | | |
| §6 emails | | | |
| Items waiting on LP4-02 PR C | — | — | **Not accepted in this round** |

A verdict of *Pass* covers only the cases you ran on the SHA above. It does not accept any
case marked **Waits on LP4-02 PR C**.
