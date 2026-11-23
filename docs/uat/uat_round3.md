# TonyAI — UAT Round 3: Test Catalogue for the Pilot Candidate

> **Purpose:** the single document for the third UAT round, run at gate G4. It covers the
> pilot candidate on **hosted QA**: four roles × two tenants × Turkish and English, with an
> explicit expected outcome for every journey.
> **Version:** 2026-11-23 · candidate = `main` as deployed to hosted QA (revision `ci80-1`,
> source `b0fe9a92`, or a later one). **Write down the SHA and revision you test** at the top
> of your sign-off (§11). The app does not display them: the owner records each QA deploy's
> revision and source SHA (the planning file's latest deploy entry); ask before you start.
> **History:** first written 2026-10-25 for a local build (`5e192a9`); corrected 2026-11-01
> from the agent pre-pass on `a9476eb` ([`uat_round3_results.md`](uat_round3_results.md));
> rewritten 2026-11-23 for hosted QA and for everything shipped since. A pre-pass never
> replaces §10 or §11.
> **Scope under test:** pilot scope. Scope 1 & 2 on **Türkiye** factors, Turkish and English
> UI, and two kinds of email (invitation, password reset). The United Kingdom is out of the
> pilot: a UK subsidiary is accepted, but its figures are refused (§7.6, ERR-06).
> **Supersedes** [`uat_round2.md`](uat_round2.md) for this build.
>
> **Emission factors are authoritative for Türkiye.** Hosted QA holds the sealed TR factor
> package (the IPCC and ETKB releases, reporting years 2024–2026) and the IPCC marine gas oil
> edition. It holds no demo or placeholder factor. A TR figure is therefore a real result and
> may be checked: the reference values in this catalogue (§7.10–§7.12) come from the
> package's own test vectors. During this run a reviewer checks the figures independently,
> through the holding (D24).
> The pilot examples (§7.14) run on the holding's own sources (D05), entered with synthetic
> values during this run.

---

## 1. What is different since the 2026-11-01 version

| | What changed | Why it matters to you |
| --- | --- | --- |
| **Hosted QA, not your laptop** | Everything runs on `https://qa.tonyai.io`. There is no seed, no `db:reset` and no mail catcher. | Your accounts, your organisations and your mailbox are real; your data must still be synthetic (§2). |
| **Companies register themselves** | `/register` creates an organisation and its first super_admin, with a registration code the owner gives you. Every new organisation starts with one default subsidiary. | Tenant A and Tenant B are made this way (§4). |
| **Authoritative TR factors** | The sealed TR package is loaded. Natural gas in Sm³ and m³ with its calorific inputs, refrigerants with equipment lines, the vehicle modes and marine gas oil are priced. | The round-1 items that waited on LP4-02 are testable now (§3). |
| **Natural gas bills in kWh or MWh** | A TR gas bill in energy units needs its calorific basis, net or gross, with no default. A gross bill shows the net figure it is priced on. | §7.11. |
| **Own generation behind the meter** | An Electricity record can state the site's own generation (solar, wind, CHP, diesel generator). It never changes the figure; it can warn. | §7.12. |
| **Record edit, recall and copy** | The author recalls a submitted record, edits a draft in an explicit Edit mode, and copies a withdrawn record to a new draft. | §7.7. |
| **Evidence for every Scope 1–2 record** | Submit and approve both need at least one file, in every Scope 1–2 category and Water. | §7.8. |
| **Anomaly on short history** | One earlier period is enough for a comparison; a first period has a typo ceiling. | §7.9. |
| **Consultants approve** | A consultant approves a record someone else entered (K2). Withdraw and lock stay with a super_admin. | §5.3. |
| **Coverage refusals answer 422** | A missing factor, conversion or calorific basis answers HTTP 422; input errors stay 400, not-found 404. | §7.6. |
| **Names on screen** | The organisation is called the parent company · *ana şirket* (in sentences such as *Whole parent company · Ana şirketin tamamı*); a location is a *Facility · İşletme / Tesis*. | Every expected sentence below uses the new words. |

---

## 2. Environment & access

| | |
| --- | --- |
| Web | **https://qa.tonyai.io** |
| API | **https://api.qa.tonyai.io/api/v1** (for the few API rows; §5.5 says how to get a token) |
| Accounts | Your own, made through `/register` (§4) or invited by your tenant's super_admin. **Never** use an account another tester uses: the UI language is saved on the account, so two people on one account switch each other's language. |
| Mailbox | A real mailbox you control. Mail comes from `no-reply@tonyai.io`. Use plus-addressing (`you+a-admin@…`) to get many accounts from one mailbox. One address belongs to one organisation only (D17). |
| Data | **Synthetic only.** Invented company names, no real person's name or address beyond your own test mailbox, no real bills: use any small PDF as evidence. |
| Limits | Bulk imports and exports allow 5 per minute per user. Registration and password-reset requests share **5 per minute per IP address**: testers on one network share that quota, and a wrong registration code counts against it. A 429 is a pause, not a result: wait a minute. |
| Don't | Do not touch an organisation you did not create for this round. Do not share the registration code. Nothing can be reset for you: a withdrawal, a confirmed boundary version and an issued report are permanent. |

### 2.1 Your two tenants

Each tenant is one registered organisation with five people. Create them in §4, then fill in
this table and keep it beside you.

| Person | Role (EN · TR label) | Tenant A address | Tenant B address | Sees |
| --- | --- | --- | --- | --- |
| admin | super_admin · *Super admin · Süper yönetici* | | | the whole organisation; writes its structure, approves, withdraws, locks, reads `/audit`, manages `/users` |
| approver | super_admin | | | the same. Approves what `admin` entered, since nobody approves their own record (D01) |
| entry | data_entry · *Data entry · Veri girişi* | | | **one** granted subsidiary only (§4.3) |
| review | consultant · *Consultant · Danışman* | | | the whole organisation; takes into review, rejects and approves (never their own record); never enters data |
| viewer | executive_viewer · *Executive viewer · Yönetici izleyici* | | | the whole organisation, read only |

### 2.2 Baseline after §4: check before testing

| What | Expected |
| --- | --- |
| Dashboard **Subsidiaries · Bağlı Şirketler** · **Facilities · İşletmeler / Tesisler** | after §4.3: **3 · 2** for admin, approver, review and viewer; **1 · 1** for entry |
| Review queue · withdrawn records · period locks · boundary versions · issued reports | all **empty / none** |
| Factor coverage legend on Data Entry | Türkiye covered for 2024–2026; the United Kingdom not covered |
| Banner on `/emissions` and `/reports` | the provenance banner (*Figures are computed from committed activity records…*), with **no** line beneath it counting placeholder or non-authoritative figures |

If something differs, stop and report it before going further.

---

## 3. Round-1 close-out: the 16 items on this build

Do the check and mark it. A failure is a round-3 finding: quote the round-1 ID. Use a TR
subsidiary unless the row says otherwise.

| ID | Round-1 ask | Round 2 | **This build** | How to verify (EN · TR) | P/F |
| --- | --- | --- | --- | --- | --- |
| SUB-1 | Subsidiaries editable | ✅ | ✅ closed | `/subsidiaries` → pencil (**Open subsidiary · Bağlı şirketi aç**) → change legal name → **Save changes · Değişiklikleri kaydet** → toast *Subsidiary settings updated successfully. · Bağlı şirket ayarları güncellendi.* | |
| SUB-2 | Super-admin control panel | ✅ | ✅ closed | Same page: **Details · Ayrıntılar**, **Reporting contact · Raporlama irtibatı**, the facilities section, **What depends on this subsidiary · Bu bağlı şirkete bağlı olanlar**. As a non-admin the page reads *Bu bağlı şirketi görüntüleyebilirsiniz, ancak yalnızca bir süper yönetici değiştirebilir.* | |
| SUB-3 | Multiple locations + Google Places | ⚠️ half | ⚠️ **half closed (unchanged)** | **Add Subsidiary · Bağlı Şirket Ekle** asks for facilities and refuses to create without one (*Add at least one operational facility · En az bir operasyonel tesis…*). Google Places autofill is **not built**; tell us whether that blocks the pilot. | |
| DE-1 | Long names overlap location | ✅ | ✅ closed | Create a subsidiary with a very long legal name, then select it in Data Entry. It truncates within its own column, in both languages. | |
| DE-2 | Stay amber until all in | ✅ | ✅ closed | A dashboard cell is green only when every entry in it is accepted (*% data entry progress · %… veri girişi ilerlemesi*). Coverage against the boundary is a separate card (§7.4). | |
| DE-3 | "Standard cubic metres" | ✅ | ✅ **priced** | TR Natural Gas → **Standard cubic metres — Sm³** → the NCV field opens prefilled with the release's value → a figure is previewed and saved (§7.10, FAC-01). | |
| DE-4 | Refrigerants scope | ⏳ | ✅ **priced** | Refrigerants asks for a gas, then its equipment lines (type, installed capacity, refill). The quantity is the lines' total capacity; the figure is capacity × leak rate + refill (§7.10, FAC-04). | |
| DE-5 | Mobile combustion + on/off-road | ⏳ | ✅ **priced on TR** | Mobile Combustion offers the five vehicle modes (on-road and off-road petrol and diesel, on-road LPG) and marine gas oil; each is priced on TR. Fuel's **Gas oil (red diesel)** is a UK fuel and has no TR factor (refused). | |
| DE-6 | Turkey grid region | ✅ | ✅ closed | Data Entry shows a factor-geography line (`TR — Türkiye …`) and no grid picker. The TR grid factor is authoritative: 600,000 kWh in 2025 is **260,400 kg CO2e** (±0.5%). | |
| DE-7 | UK + Turkey only | ✅ | ✅ closed | Geography choices are **United Kingdom (UK)** and **Türkiye (TR)**. | |
| DE-8 | Turkish characters in evidence | ✅ | ✅ closed | Upload `Şubat-Faturası-İĞÜÖÇ.pdf`. The name stays intact in the vault, on download and in `/review`, in both UI languages. | |
| DE-9 | Reporting years | ✅ | ✅ closed | Years run from the current year back ten years, newest first, plus a year already selected outside that window. TR factors exist for 2024–2026: a TR record in 2023 is refused (**422**, `no_factor`; §7.6). | |
| DASH-1 | Locations count live | ✅ | ✅ closed | Add a facility in a second tab, then return to the dashboard: **Facilities · İşletmeler / Tesisler** updates when the tab regains focus. | |
| DASH-2 | Boxes clickable | ✅ | ✅ changed | Click a coloured matrix cell → a small menu: **Open in Data Entry · Veri Girişi'nde aç** (that subsidiary, category and year selected) and **View record history · Kayıt geçmişini gör** (Emissions history, filtered). | |
| DASH-3 | Per-location completeness | ✅ | ✅ closed | A subsidiary tracked by facility shows fractions in its cells. Its drawer shows the per-facility, per-month grid, with Turkish month names in TR. | |
| EM-1 | Sales output + gas units | ✅ | ✅ closed | `/emissions` → **Intensity · Yoğunluk** → **Sales output · Satış çıktısı** (MWh). | |

**Tally:** 14 closed (DE-3, DE-4, DE-5 newly priced on TR) · 1 changed and closed (DASH-2) ·
1 half closed (SUB-3).

---

## 4. Tenants A and B: registration

Do this twice: once for Tenant A in English and once for Tenant B in Turkish. The form has no
language field: it is sent in the page's language, which follows your browser. Before
Tenant B, set the browser's preferred language to Turkish (or use a browser profile in
Turkish) and check that `/register` renders in Turkish. Suggested names: **Ege Holding A.Ş.**
(A) and **Anadolu Holding A.Ş.** (B).

### 4.1 Register

| ID | Steps | Expected | A | B |
| --- | --- | --- | --- | --- |
| REG-01 | Signed out, open `/login` | Under the form: *No account yet? · Hesabınız yok mu?* with **Register your company · Şirketinizi kaydedin** | | |
| REG-02 | `/register` with a wrong code; then the right code with one letter's case changed | Refused, the form keeps what you typed: *This registration code is not valid. Check the code you were given. · Bu kayıt kodu geçerli değil. Size verilen kodu kontrol edin.* | | |
| REG-03 | First name, last name, company name, job title, your admin address, the right code, the consent box → **Register · Kaydol** | **Check your email · E-postanızı kontrol edin** — *If {email} does not have an account yet, an email…* | | |
| REG-04 | Open the email (§6, MAIL-01) → choose a password of **≥ 12 characters** | You are signed in as the super_admin of the new organisation, in the language you chose | | |
| REG-05 | Register again with the same address | The same **Check your email** screen; **no** email arrives. The screen never says whether the address exists | | |
| REG-06 | `/subsidiaries` right after REG-04 | Exactly **one** subsidiary, named after your company, geography Türkiye, no facilities. It can be renamed, and deleted while it holds nothing — **do not delete it**: §2.2 and ADM-02 count it | | |

### 4.2 Fill the tenant

As the admin of each tenant, on `/subsidiaries` → **Add Subsidiary · Bağlı Şirket Ekle**:

| Tenant | Subsidiary | Geography | Facility |
| --- | --- | --- | --- |
| A | **Ege Enerji A.Ş.** | TR | *İzmir Tesisi* (TR) |
| A | **Thames Logistics Ltd** | UK | *Leeds Hub* (UK) |
| B | **Anadolu Enerji A.Ş.** | TR | *Bursa Fabrikası* (TR) |
| B | **Marmara Lojistik A.Ş.** | TR | *Gebze Deposu* (TR) |

With the default subsidiary from REG-06, each tenant now has **3** subsidiaries and **2**
facilities.

### 4.3 Invite the other four

`/users` → **Invite user · Kullanıcı davet et**. Mix the email languages so both catalogues are
read.

| Person | Role | Email language | Subsidiaries |
| --- | --- | --- | --- |
| approver | Super admin | English | (whole organisation) |
| entry | Data entry | Turkish | **Ege Enerji** (A) · **Anadolu Enerji** (B) only |
| review | Consultant | English | (whole organisation) |
| viewer | Executive viewer | Turkish | (whole organisation) |

Accept each invitation (§6). Then, as entry, create and submit a record with a file in its
granted subsidiary; as admin, create and submit one in another subsidiary. Approve each as a
super_admin or consultant who did not enter it.

| ID | Steps | Expected | A | B |
| --- | --- | --- | --- | --- |
| USR-01 | `/users` before accepting, and after | Each row names its access: the subsidiaries granted, or the whole organisation. A data_entry with no grant reads *None granted · Erişim verilmedi* | | |
| USR-02 | **Edit access · Erişimi düzenle** on entry's row; change a role to Data entry | The access editor opens as a row button; a role change to Data entry opens it so the grant is chosen | | |
| USR-03 | `/audit` as admin | This tenant's rows only: the registration, the subsidiaries, the invitations, the records | | |

---

## 5. Role × tenant × language matrix

Run every row four times: **Tenant A in EN, Tenant A in TR, Tenant B in EN, Tenant B in TR**.
Switch with **Language · Dil** at the bottom of the sidebar.

"**Absent**" means the control is not on the screen. "**Refused**" means the control is
there, and the API answers with the quoted sentence. Every sidebar item is shown to every
role. A screen a role may not use explains why on the screen; it does not hide.

### 5.1 super_admin: admin / approver

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| ADM-01 | Sign in, read the sidebar and the page header | Nine items. EN: Dashboard, Data Entry, Subsidiaries, Emissions, Review Queue, Reports, Inventory Boundary, Audit Trail, Users. TR: Gösterge Paneli, Veri Girişi, Bağlı Şirketler, Emisyonlar, İnceleme Kuyruğu, Raporlar, Envanter Sınırı, Denetim İzi, Kullanıcılar. Header: name, *Süper yönetici*, **Çıkış yap / Sign out** | | | | |
| ADM-02 | `/subsidiaries` | **Add Subsidiary · Bağlı Şirket Ekle** present. Pencil and bin on every row. Each tenant lists its 3 | | | | |
| ADM-03 | Create a subsidiary with one facility; then try one with none | Toast *Subsidiary created · Bağlı şirket oluşturuldu*. Without a facility: *Add at least one operational facility · En az bir operasyonel tesis…* | | | | |
| ADM-04 | Delete a subsidiary that holds an approved record | Refused. TR toast *Bu bağlı şirkete bağlı veriler varken şirket silinemez — "Bu bağlı şirkete bağlı olanlar" bölümüne bakın.* with the server's English list of dependents beneath it. The row is still there | | | | |
| ADM-05 | Delete the subsidiary from ADM-03 | Toast *Subsidiary deleted · Bağlı şirket silindi* | | | | |
| ADM-06 | `/review` → open a record **you entered** | **Approve · Onayla** absent. *You cannot approve a record you entered. · Kendi girdiğiniz bir kaydı onaylayamazsınız.* | | | | |
| ADM-07 | `/review` → approve one entered by entry | Toast *Record approved · Kayıt onaylandı*; the row leaves the queue | | | | |
| ADM-08 | `/audit` after ADM-03…07 | Columns *Zaman · Yapan · O andaki rol · İşlem · Varlık · Değişiklik*. Your changes are the newest rows. Action and entity are raw codes in both languages (M2, §9) | | | | |
| ADM-09 | `/users` → your own row → API `POST /users/<your id>/disable` | Refused 403 `own_account_forbidden`: *Kendi rolünüzü değiştiremez veya kendi hesabınızı devre dışı bırakamazsınız; başka bir süper yöneticiden isteyin.* | | | | |
| ADM-10 | `/emissions` → **History · Geçmiş** → an approved record | **Withdraw this figure · Bu rakamı geri çek** present | | | | |
| ADM-11 | `/emissions` → **Targets · Hedefler** | **Add target · Hedef ekle** present | | | | |
| ADM-12 | `/reports` → live preview | **Download PDF · PDF indir**, **Export Excel · Excel'e aktar**, **Export CSV · CSV'ye aktar** | | | | |
| ADM-13 | entry saves a new draft; as admin, open it in Data Entry; then try through the API | Opening it shows *This record was entered by someone else — only its author can change it. · Bu kaydı başka biri girdi — yalnızca kaydı giren kişi değiştirebilir.* and the form does not load it. API: `PATCH` or submit → **403** `record_author_forbidden`; `POST …/evidence` → **403** `forbidden`. Nothing changes (evidence and edits are the author's alone, super_admin included) | | | | |

### 5.2 data_entry: entry

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| ENT-01 | Dashboard, `/subsidiaries`, Data Entry's subsidiary list, `/reports` | Exactly the granted subsidiary (Ege Enerji / Anadolu Enerji). No other subsidiary's name or figures anywhere | | | | |
| ENT-02 | `/subsidiaries` | **Add Subsidiary** absent. Pencil and bin absent. The facilities drawer reads *Tesisleri yalnızca bir süper yönetici ekleyebilir veya değiştirebilir.* The locks drawer reads *Raporlama dönemlerini yalnızca bir süper yönetici kilitleyebilir veya açabilir.* | | | | |
| ENT-03 | Type `/subsidiaries/<id of a NON-granted subsidiary of the same tenant>` (copy it from admin's address bar) | The not-found page: *Subsidiary not found · Bağlı şirket bulunamadı* / *Bu bağlı şirket yok ya da artık ona erişiminiz yok.* Identical to `/subsidiaries/00000000-0000-4000-8000-000000000000` | | | | |
| ENT-04 | Data Entry → fill a new record without saving it, choose a PDF in the evidence vault, click **Submit for review · İncelemeye gönder** | One click: the draft is saved, the file uploads, the record is submitted (*Submitted for review · İncelemeye gönderildi*) | | | | |
| ENT-05 | `/review` | Gate card: *Reviewing is done by a consultant or a super_admin · İncelemeyi bir danışman veya süper yönetici yapar*, with *Rolünüz:* `data_entry`. No queue is shown | | | | |
| ENT-06 | `/audit` | *Only a super_admin can read the audit trail · Denetim izini yalnızca bir süper yönetici okuyabilir* | | | | |
| ENT-07 | `/users` | A refusal card naming your role (*Rolünüz: Veri girişi*) | | | | |
| ENT-08 | `/reports` | Live preview of the granted subsidiary. No export buttons, and the note *Your role can view report data but cannot generate or export reports. · Rolünüz rapor verilerini görebilir ancak rapor oluşturamaz veya dışa aktaramaz.* **Issued reports** tab: *Rolünüz kesinleştirilmiş raporları okumaz.* | | | | |
| ENT-09 | `/inventory-boundary` | Read only: *Bir sınırı yalnızca bir süper yönetici beyan edebilir…*. Once §7.4 has created a version the user can read, also *Yalnızca erişiminiz olan bağlı şirketleri görüyorsunuz…* | | | | |
| ENT-10 | API: `PATCH /api/v1/subsidiaries/<granted id>` with `{"legalName":"New name"}` | **403**, code `forbidden` (a role-only refusal stays generic). Nothing changes | | | | |
| ENT-11 | As admin, save a draft in entry's granted subsidiary. As entry, look at Data Entry's records table, then open that row | The row has no **Edit · Düzenle** and reads *Entered by someone else. · Başka biri tarafından girildi.* Opening it shows the sentence from ADM-13 | | | | |

### 5.3 consultant: review

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| CON-01 | Dashboard, `/subsidiaries`, `/emissions` | Whole organisation, read only. No write controls on Subsidiaries. Withdraw absent. **Add target** absent | | | | |
| CON-02 | `/review` → a submitted record someone else entered | **Start review · İncelemeye al**, **Reject · Reddet** and **Approve · Onayla** present | | | | |
| CON-03 | Reject with a reason | Reject needs a reason (*Gerekçe (reddetmek için zorunlu)*). Toast *Kayıt reddedildi — gerekçe artık gönderen tarafından görülebiliyor* | | | | |
| CON-04 | Data Entry | The **Bulk upload · Toplu yükleme** card is absent. The vault has no upload or remove control. **Save draft** is refused: *Your role may not create activity records. · Rolünüz faaliyet kaydı oluşturamaz.* | | | | |
| CON-05 | `/reports` live | Generate and export allowed | | | | |
| CON-06 | `/reports` → Issued, when the year's newest boundary version is still open | Capture is not offered for it: *Yılın en yeni sınır sürümü hâlâ açık: onu önce bir super_admin yakalayarak dondurur.* | | | | |
| CON-07 | `/audit`, `/users`, `/inventory-boundary` | ENT-06/ENT-07 wording (role *Danışman*). The boundary is read only | | | | |
| CON-08 | Approve a record entry submitted | Approved; `/audit` (as admin) shows the approval with the role at the time *Consultant · Danışman* | | | | |
| CON-09 | `/emissions` → History → an approved record | **Withdraw this figure** absent: withdraw and lock stay with a super_admin | | | | |

### 5.4 executive_viewer: viewer

| ID | Steps | Expected | A·EN | A·TR | B·EN | B·TR |
| --- | --- | --- | --- | --- | --- | --- |
| VIE-01 | Dashboard, `/emissions` (all tabs), `/subsidiaries/<id>` | Whole organisation, read only. The subsidiary page reads *Bu bağlı şirketi görüntüleyebilirsiniz, ancak yalnızca bir süper yönetici değiştirebilir.* Withdraw and **Add target** absent | | | | |
| VIE-02 | `/review` | The gate card from ENT-05, with role `executive_viewer` | | | | |
| VIE-03 | Data Entry → **Save draft** | Bulk upload card absent. Refused: *Rolünüz faaliyet kaydı oluşturamaz.* | | | | |
| VIE-04 | `/reports` live | Generate and export **allowed** (only data_entry is refused). See §10.4 | | | | |
| VIE-05 | `/reports` → Issued | Lists and downloads issued reports. *Rolünüz kesinleştirilmiş raporları okur; yakalamaz veya kesinleştirmez.* No Capture, Check or Issue | | | | |
| VIE-06 | `/audit`, `/users`, `/inventory-boundary` | Refusal cards as ENT-06/ENT-07 (*Yönetici izleyici*). The boundary is read only | | | | |
| VIE-07 | API with the viewer's token, each with a **valid** body (copy one an admin would send — the role check runs after validation, so `{}` answers 400): `POST /activity-records`, `POST /subsidiaries`, `POST /report-datasets` | **403** each (`record_create_forbidden`, then `forbidden` twice). Nothing is written | | | | |

### 5.5 Cross-tenant isolation (Tenant B ↔ Tenant A)

**Your API token:** sign in to `qa.tonyai.io` in a desktop browser, open the developer tools →
**Network**, click anything in the app, select a **GET** request to `api.qa.tonyai.io` (an OPTIONS
preflight carries no token), and copy the value after `Bearer ` in its `Authorization` header. It is **your own** token and expires
within the hour; never paste it anywhere but your API client, and keep it out of screenshots
and saved evidence. Take Tenant A's ids from the address bar or from your Tenant A account's
API reads (a subsidiary, a facility, a record, its evidence, an issuance after §7.5).

| ID | Steps (as a Tenant B user unless stated) | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| ISO-01 | B's admin, review and viewer: dashboard, Subsidiaries, Emissions, Reports, Boundary, Audit, Users | Only Tenant B's subsidiaries, people and figures. Not one Tenant A name | | |
| ISO-02 | Browser: `/subsidiaries/<A subsidiary id>` vs `/subsidiaries/00000000-0000-4000-8000-000000000000` | The same not-found page for both (*Bağlı şirket bulunamadı*) | | |
| ISO-03 | API `GET /subsidiaries/<A id>` vs the random UUID; repeat for `/locations/<A facility>`, `/activity-records/<A record>`, `/evidence/<A evidence>/url`, `/report-issuances/<A issuance>`, `/inventory-boundaries/<A version>` | **404** with **byte-identical bodies** for the foreign and the random id: `subsidiary_not_found`, `location_not_found`, `record_not_found`, `evidence_not_found`, `report_issuance_not_found`, `boundary_not_found`. A foreign id never answers 403 | | |
| ISO-04 | API `GET /subsidiaries/abc` | **400** `invalid_id` (*Bu bağlantı ya da kimlik geçerli değil.*) | | |
| ISO-05 | B's admin → `/users` → invite Tenant A's entry address | Refused: *This email address already has an account. · Bu e-posta adresinin zaten bir hesabı var.* The response does not say which organisation holds it | | |
| ISO-06 | B's admin API: invite a data_entry with `subsidiaryIds:[<A id>]`; `PATCH /users/<A user id>/role` | **404** `subsidiary_not_found`, then **404** `user_not_found`. Nothing written | | |
| ISO-07 | B's entry → Data Entry → **Download template** → its Reference sheet; then upload a row naming an A subsidiary id | The Reference sheet lists Anadolu Enerji and its facility only. The whole file is refused, 400: *Row(s) N name a reporting entity that does not exist or is not yours.*, in English under the Turkish title *İstek işlenemedi.* (§10.2). Nothing is imported | | |
| ISO-08 | A's admin: dashboard, `/audit`, `/users`, Reports totals | No Tenant B subsidiary, person, audit row or tonnage | | |

---

## 6. Emails (registration, invitation and password reset)

The pilot sends **exactly two** kinds of email: an invitation (a registration's confirmation
is one) and a password reset. They come from `no-reply@tonyai.io`. Check the spam folder once;
report it if a TonyAI email lands there.

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| MAIL-01 | The registration email (REG-03), once in EN (A) and once in TR (B) | In the language chosen on the form. Its button leads to choosing a password; Turkish characters intact in the subject, the body and the sender name | |
| MAIL-02 | An administrator's invitation in English (approver) | Subject *You're invited to {organisation} on TonyAI*. Body names the inviter. Button **Accept the invitation** | |
| MAIL-03 | A Turkish administrator invitation (entry) | *Merhaba …*, *{inviter}, sizi … davet etti.* Turkish characters intact | |
| MAIL-04 | Open an invitation link → **Continue** → set a password. Then open the **same** link again, and also an older link replaced by a re-send | First time: *Accept your invitation · Davetinizi kabul edin* → *Choose your password · Şifrenizi belirleyin*. 11 characters are refused (*En az 12 karakter kullanın.*); a mismatch reads *İki şifre birbiriyle eşleşmiyor.* Reused or replaced link: *This link no longer works · Bu bağlantı artık çalışmıyor*, with **Request a new link · Yeni bağlantı iste** | |
| MAIL-05 | After accepting, sign in | The UI opens in the **language the invitation was sent in** | |
| MAIL-06 | `/users` → **Re-send invitation · Daveti yeniden gönder** on an invited user; then on an accepted one (API) | The first gets *Invitation re-sent to … · Davet … adresine yeniden gönderildi*. The accepted one is refused 409 `invitation_closed` (*Bu davet zaten kabul edildi.*) | |
| MAIL-07 | `/login` → **Forgot your password? · Şifrenizi mi unuttunuz?** for an account whose language is TR, then for one whose language is EN | The same *Check your email · E-postanızı kontrol edin* screen for both. Subjects *TonyAI şifrenizi sıfırlayın* / *Reset your TonyAI password*. **The email follows the account's saved language, not the language of the page that requested it** | |
| MAIL-08 | Reset an unknown address; reset the same real address twice within 5 minutes | The same confirmation screen each time. No email for the unknown address, and only **one** email for the double request | |
| MAIL-09 | Covered by §7.15 (LVR-01) | | |
| MAIL-10 | Submit, approve, reject and lock anything | **No** email is sent: workflow notifications are post-pilot | |

---

## 7. Feature cases

Use your own tenant's subsidiaries and the quarterly periods of the current year unless a
case says otherwise. Every Scope 1–2 record needs a file before it is submitted (§7.8):
keep a small PDF at hand.

### 7.1 Bulk upload (entry or admin)

Imports allow **5 requests per minute per user**, and a dry run counts. Start from **Download
template · Şablonu indir**.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| BLK-01 | CSV, `activityValue` = `1.234` | The dry run lists the row under **Accepted rows · Kabul edilen satırlar** with **Amount read · Okunan miktar** = EN `1.234 kWh`, TR `1,234 kWh`, under the note that a file always uses a point for decimals | | |
| BLK-02 | XLSX with a **numeric** cell 1234.5 (Excel in Turkish shows `1234,5`) | Read as the number: EN `1,234.5 kWh`, TR `1.234,5 kWh` | | |
| BLK-03 | CSV, quoted `"1.234,5"` and `"1,5"`; XLSX **text** cells `1.234,5` and `1,5` | Each row is refused under *Comma in a number · Sayıda virgül var*, with the per-row sentence in English (K5). Nothing is imported | | |
| BLK-04 | A clean file → **Import · İçe aktar** → confirm | The imported rows are drafts: *…not included in any total and do not appear in the review queue until they are submitted below. · …hesaplamaya dahil edilmez ve inceleme kuyruğunda görünmez.* A category that needs evidence reads that a draft needs a file first: attach it, then **Send N drafts for review** | | |
| BLK-05 | Pick a `.txt` file in the panel; then send it straight to the API (`POST /bulk-upload/activity-records`) | The panel refuses before upload: *Bir .csv veya .xlsx dosyası yükleyin.* The API answers 400 `bulk_file_type` | | |
| BLK-06 | CSV with **1,001** data rows | *The file has 1,001 rows; the limit is 1,000…* · *Dosyada 1.001 satır var; sınır 1.000…* | | |
| BLK-07 | CSV saved as Windows-1254 (Turkish ANSI) with `ş/ğ` in a cell | `bulk_file_encoding`: *Dosya UTF-8 metin değil…* | | |
| BLK-08 | A header-only CSV; a text file renamed `.xlsx` | `bulk_no_rows`; `bulk_workbook_unreadable` | | |
| BLK-09 | TR subsidiary, Fuel rows with `diesel` and `gas_oil` in one month and slot | The rows stay distinct. The diesel row is priced; the `gas_oil` row is refused, since red diesel has no TR factor | | |
| BLK-10 | A TR Natural Gas row in kWh without the `cvBasis` column; then with `gross` | Without: the row is refused for the missing basis. With: accepted, and the dry run shows the basis it read | | |

### 7.2 Shared evidence (entry creates; a super_admin approves and locks)

Use the granted TR subsidiary · Natural Gas · Sm³ · Quarterly.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| EVI-01 | As entry: save drafts for **Q1** and **Q2** → in the records table, **Attach one file to several records · Tek dosyayı birden fazla kayda ekle** → tick both → choose a PDF → **Attach · Ekle** | The confirmation names both records. Toast *… artık 2 kaydı destekliyor.* | | |
| EVI-02 | Open each record's evidence | The file is on both, with *Ayrıca 1 başka kaydı destekliyor: …*. The action reads **Remove from this record · Bu kayıttan kaldır** | | |
| EVI-03 | Submit Q1. As admin approve it, then `/subsidiaries` → **Manage period locks · Dönem kilitlerini yönet** → Quarterly · Q1 → **Lock period · Dönemi kilitle** | Q1 reads **Locked · Kilitli**. Its vault is read only | | |
| EVI-04 | As entry, API `DELETE /api/v1/evidence/<file id>` | **409** `evidence_backs_locked_records`. The file stays on both records | | |
| EVI-05 | On Q2 → **Bu kayıttan kaldır** | *Bu kayıttan kaldırıldı — … hâlâ 1 başka kaydı destekliyor.* Q1 keeps the file | | |
| EVI-06 | Attach a file to Q2 again, submit it, then (admin) try to lock Quarterly · Q2 before deciding it | Refused: *Bu dönemde 1 kayıt hâlâ inceleme bekliyor — kilitlemeden önce onaylayın veya reddedin.* | | |
| EVI-07 | Unlock (**Kilidi aç**) after the test | Q1 goes back to Approved | | |

### 7.3 Turkish numbers (any role that can enter data)

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| NUM-01 | TR, Data Entry, activity value `1.234,5` → **Taslağı kaydet** | The note under the field: *1234,5 olarak okundu.* The stored value is **1234.5** | |
| NUM-02 | TR, type `1.234` | *1234 olarak okundu — 1,234 değil.* | |
| NUM-03 | TR, type `1234.5` · EN, type `1,5` | TR refused: *Ondalık ayırıcı olarak virgül kullanın, örneğin 45000,5.* EN refused: *Use a point as the decimal separator, e.g. 45000.5.* Save is not possible | |
| NUM-04 | Reopen NUM-01's draft, switch to EN, then back to TR | The field shows `1234.5` in EN and `1234,5` in TR. The stored value stays **1234.5**. **A language switch never changes a stored quantity** | |
| NUM-05 | The calculation inputs (NCV, own-generation kWh, equipment capacity) in TR | Accept `4.000,5` and save 4000.5. Text that cannot be read holds the save rather than being dropped | |
| NUM-06 | Dashboard and Emissions in TR, then EN | The same totals, grouped per language: `1.234` in TR and `1,234` in EN, `12,3` vs `12.3` | |
| NUM-07 | TR user: live **Excel'e aktar**; **CSV'ye aktar** | The workbook's figures are **numeric cells** (SUM works), with Turkish labels. The CSV keeps English machine headers and dot decimals | |

### 7.4 Inventory boundary editor (`/inventory-boundary`)

Use the current year. A **confirmed or captured version never changes**.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| BND-01 | admin → `/inventory-boundary` | *… için beyan edilmiş bir sınır yok. Beyan etmek için bir sürüme başlayın.* → **Boş bir sürüm başlat** → *Sürüm 1 başlatıldı.* | | |
| BND-02 | **Beyan et** a subsidiary, then save without choosing an attribution or cadence | The save is refused on the fields themselves. Nothing is defaulted for you | | |
| BND-03 | Complete and save it | *… kaydedildi.* or the list of gaps. The row shows months, facilities, sources and gaps | | |
| BND-04 | **Sürümü onayla** while it has gaps; then once it has none | Blocked while gaps remain. Once clean, the dialog names the undeclared subsidiaries → **Onayla** → *Sürüm 1 onaylandı.* and the version is read only | | |
| BND-05 | Edit a confirmed version through the API | 409 `boundary_frozen` | | |
| BND-06 | **Sürüm 1'den yeni sürüm** → then **Sürümü sil** on the copy | The copy opens. Delete asks *Sürüm 2 silinsin mi?* … *Bu geri alınamaz.* | | |
| BND-07 | consultant, viewer, entry | Read only (§5). entry sees only the granted subsidiary | | |

### 7.5 Issued reports (`/reports` → **Issued reports · Kesinleştirilmiş raporlar**)

On TR data a dataset can be **final**: every included record approved, on authoritative factors,
with no gap. A dataset with a gap (a record not yet approved, a UK subsidiary with no factor, a
missing month) is **partial**, and says why.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| ISS-01 | Live tab, any role that can read it | Banner *Canlı önizleme — kesinleştirilmiş bir rapor değildir…*. Live downloads are named `tonyai-live-…` | | |
| ISS-02 | Issued tab before §7.4 | *… için beyan edilmiş bir envanter sınırı yok; bu yüzden yakalanacak bir şey yok.* | | |
| ISS-03 | admin → **Envanteri yakala** | *Veri seti yakalandı*. An open version becomes *Donduruldu, onaylanmadı* on `/inventory-boundary` | | |
| ISS-04 | **Kontrol et** on a dataset with a gap (for example the UK subsidiary declared) | *Kısmi — nihai raporu engelleyen eksikler: N.*, each gap listed | | |
| ISS-05 | **Kesinleştir** → template *Yönetici özeti*, **Rapor dili: Türkçe** | *Kısmi rapor kesinleştirildi*. The list shows *Kısmi*, *Eksikler: N*, the template and the language | | |
| ISS-06 | Download its **PDF / Excel / CSV** | The PDF and workbook are in Turkish. The CSV has English headers and dot decimals, and carries the issuance, dataset and fingerprint on every row. **The three agree on every total** | | |
| ISS-07 | Issue the same dataset in **English**; then try the same language, template and options again | A second issuance with an English PDF. The repeat is refused: `report_already_issued` | | |
| ISS-08 | Approve or withdraw a record, then re-download ISS-06's PDF | The issued files are **unchanged**; the live preview has changed | | |
| ISS-09 | consultant / viewer / entry on this tab | §5: consultant captures and issues partials; viewer reads and downloads; entry *Rolünüz kesinleştirilmiş raporları okumaz.* | | |
| ISS-10 | In Tenant B (or in a new version without Thames Logistics): TR subsidiaries only, every record approved → capture → check → issue as admin | *Nihai rapor olmaya uygun*; the issuance is the **Current final · Geçerli nihai rapor**. As a consultant, **Issue** is disabled and the check reads *Qualifies as a final report. A final report is issued by a super_admin. · Nihai rapor olmaya uygun. Nihai raporu bir super_admin kesinleştirir.* Through the API the consultant is refused 403 `report_final_forbidden` | | |

### 7.6 Refusal wording (spot checks)

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| ERR-01 | TR: lock a period, then (as entry) save a draft in it | The period named in Turkish, e.g. *1. çeyrek 2026 raporlama dönemi kilitli — …* | |
| ERR-02 | TR: create a second record in an occupied slot | *Bu raporlama birimi, dönem ve kategori için zaten bir faaliyet kaydı var.* | |
| ERR-03 | TR: delete a facility holding records | *Bu tesiste N faaliyet kaydı var…* | |
| ERR-04 | TR: a role-only refusal (ENT-10 done from the UI where possible) | *Bu işlem için yetkiniz yok.* with the server's English sentence beneath it (K5) | |
| ERR-06 | Electricity on the **UK** subsidiary (Thames Logistics); a TR record in **2023**; then `POST /activity-records` naming a random subsidiary id | The first two are refused as coverage gaps, HTTP **422** `no_factor`: *No emission factor covers this category, fuel or gas, geography and year yet. · Bu kategori, yakıt ya da gaz, coğrafya ve yıl için henüz bir emisyon faktörü yok.* The unknown subsidiary answers **404** `subsidiary_not_found` | |

### 7.7 Record edit, recall and copy (entry, as the author)

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| REC-01 | Submit a record, then in the records table **Recall · Geri al** → **Recall to draft · Taslağa geri al** | *Recalled to draft. Edit it, then submit it again. · Taslağa geri alındı. Düzenleyip yeniden gönderin.* It leaves the review queue | | |
| REC-02 | A consultant starts the review (**Start review**); the author tries to recall it (API) | Refused: *Only a submitted record can be recalled… once review has started, only the reviewer can return it.* | | |
| REC-03 | **Edit · Düzenle** a draft → change its value and its period → save | The band *Editing record {id} · {id} kaydı düzenleniyor* lists the changes; the same record is saved, with its id | | |
| REC-04 | In Edit mode, change a draft that has a file to another category | The band lists the file that goes; the save needs your confirmation, otherwise *Changing the category removes every evidence file from this record…* | | |
| REC-05 | A super_admin withdraws an approved record (ADM-10); its author clicks **Copy to new draft · Yeni taslağa kopyala** | *A new draft is filled in from the voided record. Check the values, save it and attach its evidence.* No file is copied; the new draft is the author's | | |
| REC-06 | Two tabs on the same draft: save a change in the first, then save another in the second | The second is refused: the record changed after that form opened it; the changes are not saved, and the form reads the record again | | |

### 7.8 Evidence gate (every Scope 1–2 category and Water)

Approve checks evidence too (`approval_evidence_missing`), but a record without a file can no
longer be submitted, so that refusal cannot be reached on QA; it is covered by the automated
tests.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| EVD-01 | Mobile Combustion (or Refrigerants, Fugitive Gas) draft with no file → **Submit for review** | Not sent: *Saved. Attach at least one evidence file below, then submit again. · Kaydedildi. Aşağıya en az bir kanıt dosyası ekleyin, ardından yeniden gönderin.* | | |
| EVD-02 | Two Refrigerants records of the same subsidiary and year, one without a file → its evidence card | While it has no file, the card lists the documents an F-gas record accepts, and offers to attach one document to the year's other gas records | | |

### 7.9 Anomaly check

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| ANO-01 | A first Electricity record for a new subsidiary, 50,000 kWh | *First-period record · İlk dönem kaydı* — *There is no earlier period to compare with — please check the evidence document and the unit.* No reason needed to submit | | |
| ANO-02 | First period above its ceiling: Electricity **1,500,000 kWh** (or one refrigerant line of **650 kg**) | *Above the first-period ceiling · İlk dönem tavanının üstünde*; submit needs a variance reason | | |
| ANO-03 | Q1 = 10,000 kWh approved; Q2 = 20,000 kWh | Flagged on limited history: *…the only earlier period… The check rests on limited history (1 period).* Submit is refused until a reason is given (*…add a variance comment before submitting.*) | | |
| ANO-04 | Submit ANO-03's Q2 with its reason; then Q3 = 15,000 kWh | Compared with the average of the two earlier periods (Q2 counts only once submitted); within range, said as *Within range on limited history · Kısıtlı geçmişe göre beklenen aralıkta* | | |

### 7.10 TR factor inputs (calculation path)

Reference values are TR, reporting year **2025**, ±0.5%.

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| FAC-01 | Natural Gas, **Sm³**, 500,000 | The NCV opens prefilled from the release, editable; the conversion note names the release and the package's seal date. Figure **969,167 kg CO2e**. As a first period it is above the 250,000 Sm³ ceiling, so the record is flagged and needs a variance reason to submit: that is expected | | |
| FAC-02 | Enter a billed GCV as well as an edited NCV | The two exclude each other: one disables the other | | |
| FAC-03 | Natural Gas in **m³** | A volume correction factor is required (with an ⓘ explaining it); without it nothing is saved. A factor outside 0.75–30 is refused | | |
| FAC-04 | Refrigerants, annual: one line (type, capacity, refill), then a second line | The quantity is the lines' total capacity. A type with an alternative leak rate offers it; the others do not | | |
| FAC-05 | Mobile Combustion → each vehicle mode in litres; marine gas oil in tonnes | Each is priced. Marine gas oil shows its scope note (*Marine gas oil covers vessels your company owns or operates (Scope 1)… · Deniz motorini, şirketinizin sahip olduğu veya işlettiği gemileri kapsar (Kapsam 1)…*) | | |
| FAC-06 | Electricity, 600,000 kWh | **260,400 kg CO2e** (Scope 2, location-based) | | |

### 7.11 Natural gas bills in kWh or MWh (TR)

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| NG-01 | Natural Gas → unit **kWh**, a quantity, no basis | *Calorific basis of the bill · Faturanın ısıl değer esası* with **Net / Gross · Net / Brüt**, none chosen; *Choose the bill's calorific basis, net or gross, before the figure can be calculated or saved.* Nothing is previewed | | |
| NG-02 | 1,000 kWh, **Net** | **202.16 kg CO2e** | | |
| NG-03 | 1,000 kWh, **Gross** (then 1 MWh gross) | The net figure it is priced on: *Priced on ≈ 901.15 kWh net: × 0.901147 (8,250 / 9,155 kcal/Sm³), the reference ratio of … · ≈ 901,15 kWh net üzerinden fiyatlanır: × 0,901147 (8.250 / 9.155 kcal/Sm³)…*; for 1 MWh the line is in MWh (≈ 0.90 MWh net). **182.17 kg CO2e** both times | | |
| NG-04 | Change the unit from kWh to m³ and back | The quantity is cleared and asked for again; a new record starts on m³ | | |
| NG-05 | A reviewer opens NG-03's record | The review sheet shows the calorific basis, *Gross · Brüt*, beside the quantity | | |

### 7.12 Own generation behind the meter (Electricity)

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| SG-01 | Electricity record → the section *Own generation behind the meter · Sayaç arkası öz üretim* | Source **None** by default and no kWh field; the record is a plain grid record | | |
| SG-02 | Source **Solar**, generated kWh empty | The Case A and import statements appear; the section says the generated kWh is missing; nothing is previewed or saved | | |
| SG-03 | Generated 4,000, exported 5,000 | Held: exports cannot exceed the generation. Exported 4,000 is accepted | | |
| SG-04 | Facility consumption 0 | Held: the consumption must be above zero, or left empty | | |
| SG-05 | 600,000 kWh imported, solar 400,000 kWh generated, consumption 1,000,000 kWh | No warning. The figure is the same as with no source: **260,400 kg CO2e** (2025) | | |
| SG-06 | The same with consumption 900,000 kWh | *Energy balance: the grid import is 600,000 kWh, but consumption − generation + exports gives 500,000 kWh… This is a warning only.* The record still saves and submits | | |
| SG-07 | Source **Natural gas CHP** on a facility with no Natural Gas record that year | A reminder to enter the unit's gas in the facility's Natural Gas record; the record saves | | |
| SG-08 | A reviewer opens SG-07's record (and SG-06's) | The sheet shows the source and the kWh lines; a notice that no Natural Gas record of that year was found for the facility; the balance notice. Approve is still offered | | |
| SG-09 | In Edit mode, change an Electricity draft with a block to Natural Gas | Before the save: saving as another category removes the record's self-generation details. Back to Electricity, the fields return as they were | | |

### 7.13 Small UI changes

| ID | Steps | Expected | EN | TR |
| --- | --- | --- | --- | --- |
| UI-01 | `/login`: **Show password · Şifreyi göster**; also both fields on *Choose your password* | The field starts masked and toggles; Enter or Space on the button never submits; the two set-password fields toggle independently | | |
| UI-02 | `/login` and `/register` at rest | Every field and the checkbox show a visible grey border before focus | | |
| UI-03 | Withdraw a figure (ADM-10): read the dialog | It says the figure is *no longer included · artık dahil edilmez* in any total | | |
| UI-04 | Review queue in TR with a refrigerant record | The row and the sheet's title name the gas: *Soğutucu akışkanlar (R-410A)* | | |
| UI-05 | Data Entry's coverage legend with the UK subsidiary selected | The UK year reads not covered (amber), the TR years covered | | |

### 7.14 Pilot examples (G4)

One example per source the holding has (D05), on the loaded TR releases: record → approval →
lock → capture → a counted final, with the PDF, workbook and CSV reconciled to an
independently checked figure. The holding enters its own source structure with synthetic
values; a reviewer checks the figures independently. **Met in G4's run (owner, 2026-11-24);**
the filled rows are held by the owner.

| ID | Source (from D05) | Record | Final issued | Three formats agree | Independent figure | P/F |
| --- | --- | --- | --- | --- | --- | --- |
| PEX-01 | | | | | | |

### 7.15 Leaving and reset across roles (G4)

| ID | Steps | Expected | P/F |
| --- | --- | --- | --- |
| LVR-01 | admin disables viewer (**Hesabı devre dışı bırak**); viewer requests a reset and signs in | No reset email. The next request or sign-in reads *Hesabınız devre dışı bırakıldı…*. After **Hesabı etkinleştir**, the toast tells the admin the person must choose a new password via *Şifrenizi mi unuttunuz?* | |
| LVR-02 | admin changes review's role to Data entry, then back | The access editor opens for the grant (USR-02); after the change back, review's queue returns. `/audit` shows both changes | |
| LVR-03 | admin removes entry's grant of its subsidiary | entry sees no subsidiary (*No subsidiaries accessible to your account. · Hesabınızın erişebildiği bir bağlı şirket yok.*); its records stay, owned by entry, and are read by the others | |
| LVR-04 | A user who has left: disable them, then try to sign in and to reset | Refused as LVR-01; their records and audit rows stay | |

---

## 8. Recommended order

1. §4 registration and invitations (this also runs MAIL-01…06), then §2.2 baseline.
2. §3 close-out.
3. §5 matrix, first in EN and then in TR, per tenant; §5.5 isolation last within §5.
4. §7.3, §7.8, §7.9, §7.10, §7.11, §7.12, §7.7, §7.1, §7.2, §7.13.
5. §7.4 before §7.5. Check ENT-09's grants note after §7.4.
6. Last: anything that cannot be undone (withdrawals, confirmed versions, issuances), then §7.15 and MAIL-07…08.

---

## 9. Known limitations: do **not** report these as bugs

- **The United Kingdom is out of the pilot.** A UK subsidiary exists so refusals can be tested;
  its figures answer 422 `no_factor`.
- **K5: some English stays inside Turkish screens.** That covers a bulk file's per-row
  sentences, a calculation refusal's reason, the dependents named by `subsidiary_in_use`, and
  the server's sentence under a generic refusal. Each one sits beneath a Turkish title.
- **M2: audit action and entity codes are raw identifiers** in both languages. The review and
  audit gate cards print your role as its code (`data_entry`).
- **CSV files have English machine headers and dot decimals** in every language, by design
  (D16). PDF and Excel follow the report language.
- **The registration consent text is a placeholder** until the reviewed KVKK notice is
  published.
- **The withdrawn note in an issued report** still says such records are not *counted*; the
  wording follows (filed).
- No screen sets a subsidiary's tracking mode. There is no bulk review, no Google Places, and
  no workflow email. Scope 3, suppliers, report sharing, market-based Scope 2, certificates
  and avoided emissions come after the pilot.
- A withdrawal, a confirmed or captured boundary version, and an issuance cannot be undone.
- Imports and exports allow 5 per minute per user. A 429 is a pause, not a result.

---

## 10. What we would most like your judgement on

1. **Turkish domain terms.** Do *kesinleştirme* (issue), *yakalama* (capture), *geri çekme*
   (withdraw) beside the status *Geçersiz kılındı*, *beyan* (declare), *Envanter sınırı*,
   *ısıl değer esası* (calorific basis) and *sayaç arkası öz üretim* read as a Turkish
   sustainability team would say them?
2. **English under Turkish (K5).** Is a Turkish title over the server's English detail
   acceptable for the pilot, or must specific refusals be fully Turkish first?
3. **Gross gas bills.** Is the derived net line (§7.11, NG-03) clear enough to check against
   the bill?
4. **Executive viewer exports.** It may generate and export live reports, but not capture or
   issue. Is that the right line?
5. **Raw role codes on the gate cards** (`data_entry` in *Rolünüz: …*): acceptable, or should
   they read *Veri girişi* as `/users` does?
6. **The energy balance warning** (§7.12, SG-06): is 5% of the expected import the right line
   for a warning that never blocks?

---

## 11. Reporting an issue and sign-off

For each issue: **case ID**, **tenant (A/B)**, **language (EN/TR)**, **user**, **page**, numbered
steps, expected vs actual, a screenshot (and the console if something crashed; never a token),
and severity: **S1** blocks testing · **S2** wrong result, wrong data or an isolation leak ·
**S3** cosmetic. A wrong number, a quantity changed by a language switch, or anything from
another tenant is **S2 at least**. Quote the round-1 ID for §3 items.

**Build SHA tested:** ____________ · **Revision:** ____________ · **Date:** ____________

| super_admin | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.1 + §7.4 + §7.5 + §7.15 | | | | | | | |

| data_entry | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.2 + §7.1 + §7.2 + §7.3 + §7.7–§7.12 | | | | | | | |

| consultant | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.3 (+ the reviewer rows of §7.11, §7.12) | | | | | | | |

| executive_viewer | Tester | Date | Tenant A EN | Tenant A TR | Tenant B EN | Tenant B TR | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §5.4 | | | | | | | |

| Cross-cutting | Tester | Date | Verdict (Pass / Pass w/ notes / Fail) |
| --- | --- | --- | --- |
| §3 round-1 close-out | | | |
| §4 registration + §5.5 isolation | | | |
| §6 emails | | | |
| §7.6 refusal wording | | | |
| §7.13 small UI changes | | | |
| §7.14 pilot examples | | | |

A verdict of *Pass* covers only the cases you ran on the SHA above.
