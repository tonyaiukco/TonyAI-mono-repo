# TonyAI - Carbon Dashboard Design: Kapsamlı Analiz ve Backend Geliştirme Yol Haritası

> **Amaç:** Bu doküman, `carbon-dashboard-design` klasöründeki Next.js frontend tasarımını derinlemesine analiz ederek, backend geliştirmesini üstlenecek AI Agent'lar (Subagent'lar) için eksiksiz bir **teknik rehber ve geliştirme yol haritası** sunmaktadır.
>
> **Hedef Kitle:** The Architect, The Integrator, The QA & Auditor, The Security & Compliance Engineer, The Data & Emission Factor Engineer subagent'ları ve Tech Lead.
>
> **Kod Konumu:** Tüm kod tek bir Turborepo monorepo'da yönetilir — `~/Repos/TonyAI-mono-repo` (`apps/web`, `apps/api`, `packages/shared-types`, `packages/db`).
>
> **Referans Takım Yapısı:** `yapay_zeka_takim_yapisi.md`

---

## İçindekiler

1. [Projenin Genel Görünümü](#1-projenin-genel-görünümü)
2. [Frontend Teknoloji Yığını ve Mimari](#2-frontend-teknoloji-yığını-ve-mimari)
3. [Sayfa ve Modül Bazlı Detaylı Analiz](#3-sayfa-ve-modül-bazlı-detaylı-analiz)
4. [Veri Modelleri ve TypeScript Tipleri (Backend Şema Rehberi)](#4-veri-modelleri-ve-typescript-tipleri-backend-şema-rehberi)
5. [API Endpoint Tasarım Şablonu](#5-api-endpoint-tasarım-şablonu)
6. [Hesaplama Motoru (Calculation Engine) Gereksinimleri](#6-hesaplama-motoru-calculation-engine-gereksinimleri)
7. [RBAC ve Güvenlik Gereksinimleri](#7-rbac-ve-güvenlik-gereksinimleri)
8. [Anomali Tespiti ve Bildirim Sistemi](#8-anomali-tespiti-ve-bildirim-sistemi)
9. [Dosya Yönetimi ve Evidence (Kanıt) Sistemi](#9-dosya-yönetimi-ve-evidence-kanıt-sistemi)
10. [Agent Bazlı Görev Dağılımı ve Geliştirme Fazları](#10-agent-bazlı-görev-dağılımı-ve-geliştirme-fazları)
11. [Kritik İş Kuralları ve Kısıtlar](#11-kritik-iş-kuralları-ve-kısıtlar)
12. [Teknik Borç ve Dikkat Edilmesi Gerekenler](#12-teknik-borç-ve-dikkat-edilmesi-gerekenler)

---

## 1. Projenin Genel Görünümü

### 1.1 Proje Nedir?

`carbon-dashboard-design`, TonyAI ürününün **yalnızca frontend tasarımıdır** — bir Next.js 16 + React 19 projesidir. Şu an tüm veriler **statik mock (sahte) data** ile çalışmaktadır. Gerçek bir backend, veritabanı veya API yoktur.

Bu tasarım, **5 ana sayfadan** ve **72+ bileşenden** oluşan kapsamlı bir kurumsal ESG (Çevresel, Sosyal, Kurumsal Yönetişim) dashboard'udur. Tasarım, bir **v0.app** (Vercel AI) aracıyla üretilmiş ve TonyAI branding'ine uyarlanmıştır.

### 1.2 Dosya Yapısı Özeti

```
carbon-dashboard-design/
├── app/                          # Next.js App Router sayfa yapısı
│   ├── layout.tsx                # Root layout (Inter + JetBrains Mono fontları)
│   ├── globals.css               # Tema değişkenleri ve global stiller
│   ├── page.tsx                  # Ana Dashboard sayfası
│   ├── data-entry/page.tsx       # Veri Giriş sayfası
│   ├── emissions/page.tsx        # Emisyon Analiz sayfası (1316 satır - en büyük)
│   ├── reports/page.tsx          # Raporlama sayfası (790 satır)
│   └── subsidiaries/page.tsx     # İştirak Yönetimi sayfası
├── components/
│   ├── dashboard/                # Dashboard'a özel 9 bileşen
│   ├── data-entry/               # Veri girişine özel 6 bileşen
│   ├── subsidiaries/             # İştirak yönetimine özel 2 bileşen
│   ├── ui/                       # 57 Shadcn UI temel bileşen
│   └── theme-provider.tsx        # Tema sağlayıcı
├── lib/
│   ├── types.ts                  # ⭐ TÜM TypeScript tip tanımları (469 satır)
│   ├── data.ts                   # Dashboard mock verileri
│   ├── emissions-data.ts         # Emisyon analiz mock verileri
│   ├── data-entry-data.ts        # Veri giriş form yapıları ve mock
│   ├── subsidiaries-data.ts      # İştirak mock verileri
│   └── utils.ts                  # Yardımcı fonksiyonlar (cn utility)
├── hooks/
│   ├── use-mobile.ts             # Responsive hook
│   └── use-toast.ts              # Toast notification hook
├── public/                       # Statik dosyalar (ikonlar, placeholder görseller)
├── package.json                  # Bağımlılıklar
├── tsconfig.json                 # TypeScript yapılandırması
└── components.json               # Shadcn UI yapılandırması (new-york stili)
```

### 1.3 Navigasyon Yapısı (Sidebar)

Uygulama 5 ana navigasyon öğesi içerir:

| Sıra | Rota | Etiket | İkon | Açıklama |
|------|------|--------|------|----------|
| 1 | `/` | Dashboard | `LayoutDashboard` | Ana genel bakış ekranı |
| 2 | `/data-entry` | Data Entry | `ClipboardEdit` | Veri giriş formları |
| 3 | `/subsidiaries` | Subsidiaries | `Building2` | İştirak/Lokasyon yönetimi |
| 4 | `/emissions` | Emissions | `BarChart3` | Emisyon analiz ve geçmişi |
| 5 | `/reports` | Reports | `FileText` | Raporlama ve dışa aktarım |

Ek olarak sidebar'da `Settings` butonu bulunmakta, ancak henüz bir settings sayfası yoktur.

---

## 2. Frontend Teknoloji Yığını ve Mimari

### 2.1 Temel Bağımlılıklar

| Teknoloji | Versiyon | Rolü |
|-----------|----------|------|
| **Next.js** | 16.2.0 | App Router, SSR/SSG, routing |
| **React** | 19.2.4 | UI rendering |
| **Tailwind CSS** | 4.2.0 | Utility-first CSS framework |
| **Shadcn UI** | new-york stili | 57 hazır UI bileşeni (Radix UI tabanlı) |
| **Recharts** | 2.15.0 | Grafikler (Pie, Bar, Area, Treemap, Line, Composed) |
| **Lucide React** | 0.564.0 | İkonografi |
| **React Hook Form** | 7.54.1 | Form yönetimi |
| **Zod** | 3.24.1 | Form validasyonu |
| **Sonner** | 1.7.1 | Toast bildirimler |
| **date-fns** | 4.1.0 | Tarih işlemleri |
| **next-themes** | 0.4.6 | Tema yönetimi |

### 2.2 Tasarım Dili

- **Renk Paleti:** Apple-inspired premium tema
  - Primary: `#1B5E3B` (Koyu Orman Yeşili — Climate Green)
  - Background: `#FAFAFA` (Sıcak off-white)
  - Sidebar: `#EBEBF0` (Açık gri)
  - Scope 1: `#34C759` (Apple Green)
  - Scope 2: `#007AFF` (Apple Blue)
  - Scope 3: `#AF52DE` (Apple Purple)
- **Tipografi:** Inter (sans-serif) + JetBrains Mono (mono)
- **Border Radius:** `0.75rem` (12px — yuvarlatılmış köşeler)
- **Durum Renkleri:**
  - Complete: `#D1F2EB` bg / `#1D7A5F` text
  - Incomplete: `#FEF3C7` bg / `#92400E` text
  - Missing: `#FEE2E2` bg / `#B91C1C` text

### 2.3 Mimari Prensipler

- **Client-Side Rendering:** Tüm sayfalar `'use client'` direktifi kullanır
- **State Management:** Global state yönetimi için **Zustand** kullanılacaktır. Kullanıcı oturum bilgileri, yetki sınırları ve dashboard üst filtre durumları Zustand store'larında saklanacaktır. Local state için standard React `useState` ve `useMemo` kullanılmaktadır.
- **Mock Data:** Tüm veri `lib/` klasöründeki statik dosyalardan gelir
- **Responsive:** `use-mobile.ts` hook'u ile mobil uyumluluk

---

## 3. Sayfa ve Modül Bazlı Detaylı Analiz

### 3.1 Dashboard (Overview) — `app/page.tsx`

**Amaç:** C-Level yöneticiler için tek bakışta tüm organizasyonun emisyon durumunu gösteren özet ekran.

**State Yönetimi:**
```
selectedYear       → Raporlama yılı filtresi (varsayılan: 2024)
selectedCompany    → İştirak filtresi (varsayılan: 'all')
selectedPeriod     → Dönem filtresi (varsayılan: 'all')
selectedStatus     → Durum filtresi (varsayılan: 'all')
searchQuery        → Arama sorgusu
selectedSubsidiary → Detay paneli için seçili iştirak
detailOpen         → Detay Sheet açık/kapalı
```

**Bileşen Hiyerarşisi:**
```
CarbonDashboard
├── Sidebar                    → Sol navigasyon
├── Header                     → Üst filtreler (yıl, şirket, dönem, durum, arama)
├── KPICards                   → 4+ KPI kartı (toplam emisyon, scope'lar, trendler)
├── TrackingMatrix             → ⭐ Kategori x İştirak durum matrisi (kırmızı/sarı/yeşil)
├── AlertsPanel                → Uyarılar ve kritik bildirimler
├── EmissionsCharts            → Scope dağılım grafikleri
├── DataTable                  → Detaylı iştirak veri tablosu
└── SubsidiaryDetail (Sheet)   → Sağdan açılan iştirak detay paneli
```

**Backend'in Sağlaması Gereken Veriler:**
1. `GET /api/kpi?year={year}&subsidiaryId={id}` → KPI hesaplamaları (scope bazlı toplamlar, trendler, tamamlanma oranları)
2. `GET /api/subsidiaries?year={year}&status={status}&search={query}` → Filtrelenmiş iştirak listesi + kategori durumları
3. `GET /api/alerts?year={year}` → Aktif uyarılar ve anomaliler
4. `GET /api/subsidiaries/{id}/detail` → Tekil iştirak detayı

**Kritik İş Kuralı — Tracking Matrix:**
Bu matris, her iştirak için 11 emisyon kategorisinin (Electricity, Natural Gas, Fuel, Mobile Combustion, Refrigerants, Purchased Goods, Waste, Water, Business Travel, Commuting, Logistics) durumunu 3 renk koduyla gösterir:
- 🟢 **Complete:** Veriler girilmiş VE hesaplama yapılmış
- 🟡 **Incomplete:** Veriler kısmen girilmiş, eksik alanlar var (`missingFields` dizisi)
- 🔴 **Missing:** Hiçbir veri girilmemiş

---

### 3.2 Data Entry (Veri Giriş) — `app/data-entry/page.tsx`

**Amaç:** Tesis sorumlusunun ilgili dönem için emisyon verilerini kategorilere göre girmesi, taslak kaydetmesi ve onaya göndermesi.

**Sayfa Layout'u:**
```
DataEntryPage (Tam ekran, sidebar yok)
├── EntryHeader              → Üst bar (yıl, dönem, iştirak, lokasyon, kategori seçicileri + kaydet/gönder butonları)
├── CategoryNav (Sol panel)  → 11 kategori listesi (durum rozetleriyle)
├── DataForm (Merkez)        → Dinamik form alanları
│   ├── FieldGroup (N adet)  → Gruplandırılmış form alanları
│   │   └── FormField        → Tekil form alanı (number, text, select, date, file, textarea)
│   └── PreviousSubmissions  → Geçmiş dönem gönderilerinin karşılaştırması
└── StatusSidebar (Sağ panel)
    ├── Completeness Status  → Alanların doluluk durumu
    ├── CalculationPreview   → ⭐ CANLI hesaplama önizlemesi
    ├── Comments             → Yorum geçmişi (kullanıcı-danışman arası)
    ├── VersionHistory       → Versiyon geçmişi (audit trail)
    └── Attachments          → Yüklenen kanıt dosyaları
```

**Kategori Bazlı Form Yapıları (Backend Form Şeması):**

Her kategorinin kendine özgü alan grupları (FieldGroup) ve alanları (DataEntryField) vardır. Backend, bu yapıyı dinamik olarak sunmalıdır:

| Kategori | Alan Grupları | Kritik Alanlar |
|----------|--------------|----------------|
| **Electricity** | Consumption, Billing, Documentation | `total_kwh` (zorunlu), `renewable_kwh`, `grid_region` (select, zorunlu) |
| **Fuel** | Stationary Combustion, Documentation | `fuel_type` (select), `quantity` (zorunlu), `quantity_unit` (select), `purpose` (select) |
| **Business Travel** | Air Travel, Ground Transportation, Documentation | `short/medium/long_haul_km`, `travel_class`, `rental_car_km`, `train_km` |
| **Waste** | Waste Volumes, Documentation | `general_waste_tonnes`, `recycled_waste_tonnes`, `hazardous_waste_tonnes`, `disposal_method` |
| **Water** | Water Consumption, Documentation | `municipal_water_m3`, `groundwater_m3`, `recycled_water_m3` |
| **Logistics** | Freight Transport, Documentation | `road/rail/sea/air_freight_tkm` |
| **Diğer kategoriler** | Activity Data, Documentation | Generic `activity_value` + `activity_unit` |

**Canlı Hesaplama Önizleme (CalculationPreview) — THE INTEGRATOR İÇİN KRİTİK:**
```typescript
interface CalculationPreview {
  activityData: number;        // Girilen aktivite verisi (ör: 45000)
  activityUnit: string;        // Birim (ör: "kWh")
  emissionFactor: number;      // Emisyon faktörü (ör: 0.366)
  emissionFactorUnit: string;  // Faktör birimi (ör: "kg CO₂e/kWh")
  estimatedEmissions: number;  // Hesaplanan emisyon (ör: 16.47)
  emissionsUnit: string;       // Çıktı birimi (ör: "tCO₂e")
  methodology?: string;        // Metodoloji (ör: "GHG Protocol Scope 2 (Location-based)")
}
```

Bu önizleme, kullanıcı form alanına her değer girdiğinde **anlık olarak güncellenmeli**dir. Backend, bir `/api/calculate/preview` endpoint'i sunmalıdır.

**Submission Workflow:**
```
draft → submitted → in_review → approved | revision_requested
```

**Backend'in Sağlaması Gereken API'ler:**
1. `GET /api/data-entry/form-schema?category={cat}` → Dinamik form yapısı
2. `POST /api/data-entry/calculate-preview` → Canlı hesaplama
3. `POST /api/data-entry/save-draft` → Taslak kaydetme
4. `POST /api/data-entry/submit` → Onaya gönderme
5. `GET /api/data-entry/submissions?subsidiaryId={id}&year={year}&period={period}` → Geçmiş gönderimler
6. `POST /api/data-entry/comments` → Yorum ekleme
7. `GET /api/data-entry/version-history/{submissionId}` → Versiyon geçmişi

---

### 3.3 Subsidiaries (İştirak Yönetimi) — `app/subsidiaries/page.tsx`

**Amaç:** Holding > İştirak > Lokasyon hiyerarşisinin CRUD (Oluştur/Oku/Güncelle/Sil) yönetimi.

**Ana Bileşenler:**
```
SubsidiariesPage
├── Sidebar
├── Summary Cards (4 adet)
│   ├── Total Subsidiaries (aktif sayı dahil)
│   ├── Total Locations
│   ├── Child Subsidiaries (iç içe şirketler)
│   └── Countries (coğrafi kapsam)
├── SubsidiaryTable            → Filtrelenebilir/sıralanabilir tablo
├── SubsidiaryForm (Sheet)     → Ekleme/düzenleme formu (sağdan açılır)
├── View Details (Sheet)       → Detay görüntüleme (salt okunur)
└── Delete Confirmation (AlertDialog)
```

**İştirak Veri Modeli (SubsidiaryCompany) — THE ARCHITECT İÇİN KRİTİK:**
```typescript
interface SubsidiaryCompany {
  id: string;
  // Şirket Bilgileri
  officialName: string;
  country: string;          // Ülke listesinden seçim (30 ülke tanımlı)
  city: string;
  postalCode: string;
  address: string;
  // Faaliyet Bilgileri
  naceCode: string;         // NACE sektör kodu (31 tanımlı kod)
  naceDescription: string;
  capacityReport: CapacityReport | null;  // PDF kapasite raporu
  // İletişim
  authorizedRepresentative: string;
  representativeContact: string;
  // Organizasyon Yapısı
  hasMultipleLocations: boolean;
  locations: Location[];     // Alt lokasyonlar dizisi
  hasChildSubsidiaries: boolean;
  childSubsidiaryCount: number;
  // Meta
  status: 'active' | 'inactive' | 'pending';
  createdAt: string;
  updatedAt: string;
}
```

**Lokasyon Veri Modeli:**
```typescript
interface Location {
  id: string;
  name: string;
  address: string;
  activityDescription: string;
  generalInfo: string;
  authorizedPerson: string;
  email: string;
  department: string;        // 14 departman seçeneği tanımlı
  createdAt: string;
  updatedAt: string;
}
```

**Backend API'ler:**
1. `GET /api/subsidiaries` → Liste (filtre, sıralama, sayfalama)
2. `GET /api/subsidiaries/{id}` → Tekil detay (lokasyonlarıyla birlikte)
3. `POST /api/subsidiaries` → Yeni iştirak oluşturma
4. `PUT /api/subsidiaries/{id}` → Güncelleme
5. `DELETE /api/subsidiaries/{id}` → Silme (cascade: lokasyonlar da silinmeli)
6. `POST /api/subsidiaries/{id}/locations` → Lokasyon ekleme
7. `PUT /api/subsidiaries/{id}/locations/{locId}` → Lokasyon güncelleme
8. `DELETE /api/subsidiaries/{id}/locations/{locId}` → Lokasyon silme
9. `POST /api/subsidiaries/{id}/capacity-report` → Kapasite raporu yükleme

---

### 3.4 Emissions Analytics — `app/emissions/page.tsx`

**Amaç:** Tüm organizasyonun emisyon verilerini derinlemesine analiz eden, 5 alt sekmeye sahip kapsamlı analiz sayfası. **Bu, uygulamanın en karmaşık sayfasıdır (1316 satır).**

**5 Alt Sekme (Tab):**

#### Tab 1: Summary (Özet)
- **Scope Metric Kartları:** Scope 1/2/3 toplamları (absolute veya intensity modunda)
- **Donut Chart:** Scope filtresine göre dinamik değişir:
  - `all` → 3 scope dağılımı
  - `scope1` → 4 alt kategori (Stationary Combustion, Mobile Combustion, Process Emissions, Fugitive Emissions)
  - `scope2` → 4 alt kategori (Purchased Electricity/Heating/Cooling/Steam)
  - `scope3` → 6 alt kategori (Purchased Goods, Business Travel, Employee Commuting, Upstream Transportation, Waste Generated, Capital Goods)
- **Top 5 Contributors:** Subsidiary veya Category bazlı bar chart

#### Tab 2: Breakdown (Kırılım)
- **Treemap:** Kategori bazlı ölçek görselleştirmesi (scope renklerine göre)
- **Category Performance Tablosu:** Kategori, Scope, Absolute Emissions, % of Total, Data Quality Score (0-100 arası kalite puanı)

#### Tab 3: History (Geçmiş)
- **Audit Ledger (Denetim Defteri):** Tüm emisyon kayıtlarının kronolojik listesi
- Her kayıt: Timestamp, Subsidiary, Category, Activity Value, Unit, tCO₂e, Status, Evidence
- **Anomaly Flag:** Anormal kayıtlar `⚠️` ikonu ile işaretlenir
- **Kayıt Detay Paneli (Sheet):** Tıklanan kaydın tam detayı (emisyon faktörü, metodoloji, coğrafya kodu, variance nedeni)

#### Tab 4: Targets (Hedefler)
- **Target Progress Kartları:** Her hedef için ilerleme çubuğu ve durum (On Track / At Risk / Off Track)
- **Target Pathway Grafiği:** Yıllara göre gerçekleşen vs hedef vs baseline çizgi grafiği
- 3 hedef türü: `science_based`, `internal_annual`, `baseline_reduction`

#### Tab 5: Trends (Trendler)
- **Periyot Seçimi:** Monthly / Quarterly / Yearly
- **Stacked Area Chart:** Scope 1/2/3 zaman serisi
- **YTD Change:** Yıl başından bu yana değişim yüzdesi

**Üst Filtreler:**
- Scope filtresi (All / Scope 1 / Scope 2 / Scope 3)
- Category filtresi (11 kategori)
- Data View (Absolute / Intensity)
- Intensity Metric seçimi (Area m², Revenue M EUR, Headcount FTE, Production Output units)
- Export butonu

**EmissionsRecord (Kayıt Modeli) — THE ARCHITECT İÇİN KRİTİK:**
```typescript
interface EmissionsRecord {
  id: string;
  timestamp: string;
  subsidiary: string;
  subsidiaryId: string;
  category: Category;
  scope: 1 | 2 | 3;
  activityValue: number;       // Aktivite verisi
  unit: string;                // Birim (kWh, m³, liters, km, kg, tkm)
  tCo2e: number;               // Hesaplanan emisyon
  status: 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'locked';
  evidenceCount: number;
  evidenceTypes: ('pdf' | 'image' | 'spreadsheet')[];
  enteredBy: string;
  invoiceReference?: string;
  notes?: string;
  anomalyFlagged?: boolean;
  // Denetim Detayları
  emissionFactor: number;
  emissionFactorUnit: string;
  methodology: string;         // 'Location-based', 'Direct measurement', 'Fuel-based calculation', vb.
  geographyCode: string;       // 'TR', 'DE', 'EU'
  createdAt: string;
  updatedAt: string;
  varianceReason?: string;     // Anomali veya red nedeni
}
```

**Backend API'ler:**
1. `GET /api/emissions/records?scope={scope}&category={cat}&search={q}&page={n}` → Filtrelenmiş kayıtlar
2. `GET /api/emissions/records/{id}` → Kayıt detayı
3. `GET /api/emissions/scope-totals?year={year}&subsidiaryId={id}` → Scope toplamları
4. `GET /api/emissions/category-breakdown` → Kategori bazlı kırılım
5. `GET /api/emissions/trends?period={monthly|quarterly|yearly}` → Trend verileri
6. `GET /api/emissions/top-contributors?by={subsidiary|category}&limit={n}` → En büyük katkıda bulunanlar
7. `GET /api/emissions/targets` → Hedef listesi
8. `GET /api/emissions/target-progress/{targetId}` → Hedef ilerleme hesaplaması
9. `GET /api/emissions/intensity?metric={revenue|area|headcount|production}` → Yoğunluk hesaplama

---

### 3.5 Reports & Disclosures (Raporlama) — `app/reports/page.tsx`

**Amaç:** ISO/GHG Protokolüne uygun, denetime hazır (audit-ready) PDF ve Excel raporları oluşturma.

**Sayfa Durumları:**
```
empty → processing (2sn simülasyon) → preview
```

**Report Configuration:**
```typescript
interface ReportConfig {
  template: 'executive_summary' | 'ghg_protocol_detail' | 'subsidiary_comparison' | 'supplier_scorecard';
  organisationScope: string[];     // Seçili iştiraklerin adları (boş = tüm portföy)
  timeframe: string;               // 'Q1 2024', '2023', vb.
  includeScope3: boolean;
  includeMethodologyNotes: boolean;
  includeEvidenceLinks: boolean;
}
```

**4 Rapor Şablonu:**
| ID | Ad | Açıklama |
|----|-----|----------|
| `executive_summary` | Executive Summary | Üst yönetim için özet rapor |
| `ghg_protocol_detail` | GHG Protocol Detail | GHG Protokolü standartlarına uygun detaylı kırılım |
| `subsidiary_comparison` | Subsidiary Comparison | İştirakler arası karşılaştırmalı analiz |
| `supplier_scorecard` | Supplier ESG Scorecard | Tedarikçi sürdürülebilirlik performans raporu |

**Rapor Önizleme İçeriği:**
1. **Header:** TonyAI branding + rapor durumu rozeti + zaman dilimi + organizasyon kapsamı
2. **Executive Summary:** 4 metrik kartı (Total, Scope 1/2/3)
3. **YoY Comparison:** Baseline'a göre değişim yüzdesi
4. **Grafikler:** Scope dağılım donut + Top Contributors bar chart
5. **Category Breakdown Tablosu:** Emissions + Data Quality Score
6. **Subsidiary Performance Tablosu:** Toplam tCO2e + Tamamlanma oranı + Durum
7. **Methodology Appendix:** Kullanılan faktör kaynakları (DEFRA, Turkey National, AIB Residual Mix) + GHG Protocol + Reporting Boundary

**Rapor Durumu:**
- `approved` → Veriler eksiksiz ve onaylı
- `draft` → Bazı veriler taslak veya inceleme aşamasında
- `contains_incomplete_data` → %15'ten fazla kayıt onaysız (uyarı banner gösterilir)

**Dışa Aktarım Seçenekleri:** PDF, Excel, Share (Link + Email via Resend)

**Rapor Geçmişi (Generation Log):**
```typescript
interface ReportGenerationLog {
  id: string;
  generatedBy: string;
  generatedAt: string;
  organisationScope: string[];
  reportingPeriod: string;
  template: ReportTemplate;
  includeScope3: boolean;
  includeMethodologyNotes: boolean;
  includeEvidenceLinks: boolean;
  exportType: 'pdf' | 'excel' | 'preview' | null;
  status: ReportStatus;
}
```

**Backend API'ler:**
1. `POST /api/reports/generate` → Rapor oluşturma (config body ile)
2. `GET /api/reports/{id}/preview` → Rapor önizleme verisi
3. `GET /api/reports/{id}/download?format={pdf|excel}` → Dosya indirme
4. `POST /api/reports/{id}/share` → Rapor paylaşma (email gönderimi)
5. `GET /api/reports/history` → Rapor oluşturma geçmişi

---

## 4. Veri Modelleri ve TypeScript Tipleri (Backend Şema Rehberi)

### 4.1 Enum ve Sabit Değerler

**Durum Enumları:**
```sql
-- Data Status
CREATE TYPE data_status AS ENUM ('complete', 'incomplete', 'missing');

-- Submission Status
CREATE TYPE submission_status AS ENUM ('draft', 'submitted', 'in_review', 'approved', 'revision_requested');

-- Emissions Record Status
CREATE TYPE emissions_record_status AS ENUM ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'locked');

-- Subsidiary Status
CREATE TYPE subsidiary_status AS ENUM ('active', 'inactive', 'pending');

-- User Role (canonical 4 rol; technical_analysis.md §4 ile hizalı)
CREATE TYPE user_role AS ENUM ('super_admin', 'consultant', 'data_entry', 'executive_viewer');

-- Reporting Period
CREATE TYPE reporting_period AS ENUM ('monthly', 'quarterly', 'annual');
```

> **Kategori sayısı netleştirmesi:** Sistemde **11 operasyonel emisyon kategorisi** uygulanır (Electricity, Natural Gas, Fuel, Mobile Combustion, Refrigerants, Purchased Goods, Waste, Water, Business Travel, Commuting, Logistics). Bu set, GHG Protocol'ün 15 Scope 3 kategorisinin tamamını değil, ürünün ilk kapsamında ele alınan **alt kümeyi** temsil eder; `md_docs`'taki "15 Scope 3 kategorisi" ifadesi standardın tam listesine atıftır. Kapsam genişletmesi Faz 2'de ele alınır.

### 4.2 Emisyon Kategorileri ve Scope Eşlemesi

Bu eşleme, hesaplama motorunun temelidir:

| Kategori | Scope | Açıklama |
|----------|-------|----------|
| Electricity | **2** | Satın alınan elektrik |
| Natural Gas | **1** | Doğalgaz (doğrudan yanma) |
| Fuel | **1** | Yakıt (sabit yanma) |
| Mobile Combustion | **1** | Taşıt yakıtı |
| Refrigerants | **1** | Soğutucu gazlar (kaçak) |
| Purchased Goods | **3** | Satın alınan mal ve hizmetler |
| Waste | **3** | Atık yönetimi |
| Water | **3** | Su tüketimi |
| Business Travel | **3** | İş seyahati |
| Commuting | **3** | Çalışan ulaşımı |
| Logistics | **3** | Lojistik/taşımacılık |

### 4.3 Emisyon Faktörü Kaynakları (Methodology Sources)

```typescript
const METHODOLOGY_SOURCES = [
  { id: 'defra', name: 'DEFRA', geography: 'United Kingdom', version: '2024' },
  { id: 'turkey_national', name: 'Turkey National Factors', geography: 'Turkey', version: '2023' },
  { id: 'aib_residual', name: 'AIB Residual Mix', geography: 'European Union', version: '2023' },
  { id: 'custom', name: 'Organisation Custom Factors', geography: 'Custom', version: 'N/A' },
];
```

### 4.4 Yoğunluk Metrikleri (Intensity Metrics)

```typescript
const INTENSITY_METRICS = [
  { id: 'area', name: 'Area', unit: 'm²', value: 125000 },
  { id: 'revenue', name: 'Revenue', unit: 'M EUR', value: 450 },
  { id: 'headcount', name: 'Headcount', unit: 'FTE', value: 2850 },
  { id: 'production', name: 'Production Output', unit: 'units', value: 1250000 },
];
```

---

## 5. API Endpoint Tasarım Şablonu

### 5.1 Önerilen API Yapısı

Backend aşağıdaki endpoint gruplarını sunmalıdır. Tüm endpoint'ler JWT ile korunmalıdır.

```
/api/v1/
├── auth/
│   ├── POST   /login
│   ├── POST   /logout
│   ├── POST   /refresh
│   └── GET    /me                    → Kullanıcı profili + roller + erişilebilir iştirakleri
│
├── subsidiaries/
│   ├── GET    /                      → Liste (filtreleme + sayfalama)
│   ├── GET    /:id                   → Detay (lokasyonlarıyla birlikte)
│   ├── POST   /                     → Yeni oluştur
│   ├── PUT    /:id                   → Güncelle
│   ├── DELETE /:id                   → Sil (soft-delete önerilir)
│   ├── POST   /:id/locations        → Lokasyon ekle
│   ├── PUT    /:id/locations/:locId  → Lokasyon güncelle
│   └── DELETE /:id/locations/:locId  → Lokasyon sil
│
├── data-entry/
│   ├── GET    /form-schema/:category → Dinamik form şeması
│   ├── POST   /calculate-preview     → Canlı hesaplama (Debounce 300ms ile API üzerinden)
│   ├── GET    /submissions           → İştirak + dönem bazlı gönderimler
│   ├── GET    /submissions/:id       → Tekil gönderim detayı
│   ├── POST   /submissions           → Yeni gönderim oluştur
│   ├── PUT    /submissions/:id       → Güncelle (taslak kaydet)
│   ├── POST   /submissions/:id/submit → Onaya gönder
│   ├── POST   /submissions/:id/approve → Onayla (Consultant/Admin)
│   ├── POST   /submissions/:id/reject  → Reddet (neden ile)
│   ├── POST   /submissions/:id/comments → Yorum ekle
│   ├── GET    /submissions/:id/versions → Versiyon geçmişi
│   └── POST   /submissions/:id/attachments → Dosya yükle
│
├── emissions/
│   ├── GET    /records               → Filtrelenmiş kayıtlar (scope, category, search, pagination)
│   ├── GET    /records/:id           → Kayıt detayı (audit bilgileriyle)
│   ├── GET    /scope-totals          → Scope bazlı toplamlar
│   ├── GET    /category-breakdown    → Kategori bazlı kırılım + data quality score
│   ├── GET    /trends                → Zaman serisi (monthly/quarterly/yearly)
│   ├── GET    /top-contributors      → En büyük katkıda bulunanlar
│   ├── GET    /targets               → Hedef listesi
│   ├── GET    /target-progress/:id   → Hedef ilerleme
│   └── GET    /subcategory-breakdown/:scope → Scope alt kategori dağılımı
│
├── reports/
│   ├── POST   /generate              → Rapor oluştur
│   ├── GET    /:id/preview           → Önizleme verisi
│   ├── GET    /:id/download          → PDF/Excel indirme
│   ├── POST   /:id/share             → Email ile paylaş (Resend entegrasyonu)
│   └── GET    /history               → Oluşturma geçmişi
│
├── alerts/
│   ├── GET    /                      → Aktif uyarılar
│   └── PUT    /:id/dismiss           → Uyarıyı kapat
│
├── kpi/
│   └── GET    /dashboard             → Dashboard KPI hesaplamaları
│
└── admin/
    ├── GET    /emission-factors      → Emisyon faktörleri yönetimi
    ├── PUT    /emission-factors/:id  → Faktör güncelleme
    └── GET    /audit-log             → Denetim izi
```

---

## 6. Hesaplama Motoru (Calculation Engine) Gereksinimleri

### 6.1 Temel Hesaplama Formülü

```
tCO₂e = Aktivite Verisi × Emisyon Faktörü
```

**Örnek:**
```
Elektrik: 45,000 kWh × 0.366 kg CO₂e/kWh = 16,470 kg CO₂e = 16.47 tCO₂e
Doğalgaz: 18,500 m³ × 0.588 tCO₂e/m³ = 10,878 tCO₂e
Yakıt:    4,320 litre × 2.64 tCO₂e/litre = 11,404.8 tCO₂e
```

### 6.2 Emisyon Faktörü Seçim Mantığı

Faktör seçimi şu parametrelere bağlıdır:
1. **Kategori** (Electricity, Natural Gas, Fuel, vb.)
2. **Coğrafya Kodu** (TR, DE, UK, EU)
3. **Raporlama Yılı** (2023 verisi için 2023 faktörü kullanılmalı)
4. **Metodoloji** (Location-based vs Market-based — özellikle elektrik için)

### 6.3 Faktör Versiyonlama (Factor Versioning)

> ⚠️ **KRİTİK İŞ KURALI:** Geçmiş yıllara ait verilerin hesaplamaları **ASLA değişmemelidir**. 2023 yılı için DEFRA 2023 faktörleri kullanıldıysa, DEFRA 2024 çıktığında 2023 hesaplamaları etkilenmemelidir. Her hesaplama kaydı, kullanılan `emissionFactor`, `emissionFactorUnit` ve `methodology` bilgilerini saklamalıdır.

### 6.4 Scope Alt Kategori Yapısı

Scope bazlı alt kategoriler ve değerleri:

**Scope 1 Alt Kategorileri:**
- Stationary Combustion (Doğalgaz + Yakıt)
- Mobile Combustion (Taşıt yakıtı)
- Process Emissions (Üretim sürecinden)
- Fugitive Emissions (Soğutucu gaz kaçakları)

**Scope 2 Alt Kategorileri:**
- Purchased Electricity
- Purchased Heating
- Purchased Cooling
- Purchased Steam

**Scope 3 Alt Kategorileri:**
- Purchased Goods & Services
- Capital Goods
- Business Travel
- Employee Commuting
- Waste Generated
- Upstream Transportation
- Downstream Transportation
- Investments

### 6.5 Target Progress Hesaplaması

```typescript
function calculateTargetProgress(target, currentEmissions) {
  const varianceToTarget = currentEmissions - target.targetEmissions;
  const totalReductionNeeded = target.baselineEmissions - target.targetEmissions;
  const actualReduction = target.baselineEmissions - currentEmissions;
  const progressPercent = (actualReduction / totalReductionNeeded) * 100;

  let status = 'on_track';
  if (progressPercent < 50) status = 'off_track';
  else if (progressPercent < 80) status = 'at_risk';

  return { varianceToTarget, progressPercent, status };
}
```

---

## 7. RBAC ve Güvenlik Gereksinimleri

### 7.1 Rol Tanımları

| Rol | Dashboard | Data Entry | Subsidiaries | Emissions | Reports |
|-----|-----------|-----------|--------------|-----------|---------|
| **Super Admin** | ✅ Tam erişim | ✅ Tümü | ✅ CRUD | ✅ Tümü | ✅ Tümü |
| **Consultant** | ✅ Atanan iştirakleri | ✅ İnceleme + onay | ✅ Salt okuma | ✅ Atanan iştirakleri | ✅ Oluşturma |
| **Data Entry** | ❌ Yok | ✅ Sadece atandığı lokasyonlar | ❌ Yok | ❌ Yok | ❌ Yok |
| **Executive Viewer** | ✅ Tam görüntüleme | ❌ Yok | ✅ Salt okuma | ✅ Tam görüntüleme | ✅ İndirme |

### 7.2 Tenant Isolation (Kiracı İzolasyonu)

Her API çağrısında:
1. JWT'den kullanıcının `role` ve `accessibleSubsidiaryIds` bilgisi çıkarılır
2. Sorgular **backend'de** `WHERE subsidiary_id IN (accessible_ids)` ile kısıtlanır
3. **Frontend filtreleme yeterli değildir** — veriler mutlaka backend'de korunmalıdır

### 7.3 Audit Trail (Denetim İzi)

Her veri değişikliği şu bilgileri kaydetmelidir:
- `user_id`, `action` (create/update/delete/approve/reject), `timestamp`
- `old_value`, `new_value` (JSON diff)
- `ip_address`, `user_agent`

### 7.4 Locked Periods (Kilitli Dönemler)

Onaylanan dönemler `locked` durumuna geçtiğinde:
- Veriler değiştirilemez (immutable)
- Sadece Super Admin kilidini açabilir (audit log'a yazılır)

---

## 8. Anomali Tespiti ve Bildirim Sistemi

### 8.1 Anomali Kuralları

Frontend'de `anomalyFlagged: boolean` ve `varianceReason: string` alanları gösteriliyor. Backend şu kuralları uygulamalıdır:

1. **Yüksek Sapma:** Aynı iştirak + aynı kategori için önceki döneme göre **%50'den fazla** artış → Anomali flag'i
2. **Eksik Kanıt:** Veri girilmiş ama kanıt (evidence) yüklenmemiş → Uyarı
3. **Geç Giriş:** Dönem kapanışından sonra girilen veriler → Bilgi notu

### 8.2 Alert Sistemi

Frontend'deki alert yapısı:
```typescript
interface Alert {
  id: string;
  type: 'warning' | 'error' | 'info';
  message: string;
  subsidiary: string;
  category?: string;
  timestamp: string;
}
```

### 8.3 Email Bildirim Senaryoları (Resend Entegrasyonu)

- Anomali tespit edildiğinde → İlgili Consultant'a email
- Veri onaya gönderildiğinde → Consultant'a email
- Veri reddedildiğinde → Data Entry kullanıcısına email
- Dönem kapanışı yaklaştığında → Eksik verileri olan tesis sorumlularına email
- Rapor oluşturulduğunda → Paylaşılan kişilere email

---

## 9. Dosya Yönetimi ve Evidence (Kanıt) Sistemi

### 9.1 Desteklenen Dosya Tipleri

- **PDF:** Faturalar, kapasite raporları
- **Image:** Fotoğraflar (sayaç okuma vb.)
- **Spreadsheet:** Excel/CSV toplu veri yükleme

### 9.2 Dosya Depolama (Supabase Storage)

- Her dosya `subsidiaryId/year/period/category/` dizin yapısında saklanmalı
- Dosya boyutu limiti belirlenmeli (önerilen: max 10MB/dosya)
- MIME type kontrolü yapılmalı (sadece izin verilen tipler)

### 9.3 Bulk Upload (Toplu Veri Yükleme)

Frontend'de henüz implementasyonu olmamakla birlikte, `technical_analysis.md`'de belirtildiği üzere holdinglerin geçmiş yıllara ait devasa CSV/Excel dosyalarını tek tuşla sisteme aktarabilecek bir mekanizma gereklidir.

---

## 10. Agent Bazlı Görev Dağılımı ve Geliştirme Fazları

> **Ekip:** 7 uzman subagent + Tech Lead (orkestratör). Aşağıdaki blok başlıkları her subagent'ın faz bazlı görevlerini listeler.

### 10.0 İlk Milestone — İnce Dikey Dilim (Vertical Slice)

> **Hedef:** Tek bir akışı uçtan uca canlı veriyle çalıştırıp entegrasyon, RBAC ve deploy riskini en başta çözmek. Faz 1'in tamamına geçmeden önce yapılır.

- [ ] **DevOps:** `~/Repos/TonyAI-mono-repo` Turborepo iskeleti; mevcut önyüzün `apps/web`'e taşınması; Supabase Dev/Staging.
- [ ] **Architect:** `subsidiaries`, `locations`, `user_subsidiary_access`, `audit_log` şeması + `packages/shared-types`.
- [ ] **Security:** Supabase Auth + login akışı (önyüzde yok); NestJS tenant guard + temel RLS.
- [ ] **Integrator:** NestJS `/subsidiaries` CRUD + `/kpi`; önyüzde `lib/api.ts` + Zustand; Subsidiaries ve Dashboard sayfalarının mock'tan gerçek veriye geçişi.
- [ ] **QA:** login → dashboard → subsidiary CRUD → KPI canlı güncellenir; Playwright smoke testi; tenant izolasyonu doğrulaması.

### 10.1 Faz 1 — MVP (Minimum Viable Product)

> **Hedef:** Dashboard + Data Entry (Scope 1 ve 2) + Temel Hesaplama Motoru

#### The Architect Görevleri (Faz 1):
- [ ] Supabase PostgreSQL veritabanı şeması tasarımı:
  - `subsidiaries` tablosu
  - `locations` tablosu (subsidiaries ile 1:N ilişki)
  - `emission_categories` sabit tablosu (11 kategori + scope eşlemesi)
  - `emission_factors` tablosu (kategori + coğrafya + yıl + faktör değeri)
  - `data_submissions` tablosu (form gönderileri)
  - `submission_field_values` tablosu (dinamik form alanları)
  - `emission_records` tablosu (onaylanan hesaplamalar)
  - `users` tablosu + Supabase Auth entegrasyonu
  - `user_roles` ve `user_subsidiary_access` tabloları (RBAC)
  - `audit_log` tablosu
- [ ] Row Level Security (RLS) politikaları
- [ ] Emisyon faktörü seed data (DEFRA 2023/2024, Turkey National 2023)
- [ ] NACE kodları seed data (31 adet)
- [ ] Hesaplama motoru algoritma tasarımı
- [ ] API endpoint şemaları (OpenAPI/Swagger)

#### The Integrator Görevleri (Faz 1):
- [ ] Supabase Client entegrasyonu (Frontend SDK)
- [ ] Auth flow implementasyonu (login/logout/session)
- [ ] Dashboard → Backend bağlantısı (KPI, subsidiaries, alerts)
- [ ] Data Entry → Form şeması API bağlantısı
- [ ] Data Entry → Canlı hesaplama önizleme API bağlantısı
- [ ] Data Entry → Taslak kaydetme / onaya gönderme
- [ ] Subsidiaries → CRUD API bağlantısı
- [ ] Dosya yükleme (Supabase Storage) entegrasyonu

#### The QA & Auditor Görevleri (Faz 1):
- [ ] Hesaplama formülü unit testleri (bilinen girdi → bilinen çıktı)
- [ ] RBAC testleri (Data Entry kullanıcısı admin API'ye erişememeli)
- [ ] Form validasyon testleri (zorunlu alanlar, sayısal sınırlar)
- [ ] Audit log yazım testleri

#### The DevOps & Cloud Engineer Görevleri (Faz 1):
- [ ] Supabase projesinin oluşturulması ve Development/Staging veritabanı ortamlarının kurulması
- [ ] GitHub organizasyonu ve takım repolarının kurulması
- [ ] Geliştiriciler için Dockerfile ve docker-compose yapılandırmasının hazırlanması
- [ ] GCP (Cloud Run) veya Azure (App Service) bulut altyapısı entegrasyonu (Staging deployment için)

#### The Security & Compliance Engineer Görevleri (Faz 1):
- [ ] RBAC rol/izin matrisinin tanımı (4 rol: `super_admin`, `consultant`, `data_entry`, `executive_viewer`)
- [ ] NestJS tenant guard'ı (birincil enforcement): her sorguda `accessibleSubsidiaryIds` kısıtı
- [ ] Supabase RLS politikaları (defense-in-depth): `subsidiaries`, `locations`, `data_submissions`, `emission_records`
- [ ] `audit_log` yazımının değişmezliği (append-only) ve her CRUD aksiyonuna bağlanması
- [ ] KVKK/GDPR veri yerleşimi gereksinimlerinin ilk doğrulaması

#### The Data & Emission Factor Engineer Görevleri (Faz 1):
- [ ] `emission_factors` seed'i: DEFRA 2023/2024 (UK), Turkey National 2023 — Scope 1 & 2 için
- [ ] Faktör versiyonlama mantığı (yıl + coğrafya bazlı; geçmiş hesaplama asla değişmez)
- [ ] Birim normalizasyonu kuralları (ör. m³ → kWh, MWh → kWh)
- [ ] `emission_categories` (11 kategori) + scope eşleme verisinin doğrulanması
- [ ] Hesaplama sonuçlarının ISO 14064-1 / GHG Protocol metodolojisine uygunluk kontrolü

### 10.2 Faz 2 — Advanced (Gelişmiş)

> **Hedef:** Emissions Analytics + Reports + Scope 3 + Anomali Tespiti + Bulk Upload

#### The Architect Görevleri (Faz 2):
- [ ] `emissions_targets` tablosu (Science Based / Internal / Baseline)
- [ ] `report_generation_log` tablosu
- [ ] `alerts` tablosu
- [ ] `comments` tablosu (data submission'lara bağlı)
- [ ] `version_history` tablosu
- [ ] Anomali tespit algoritması (önceki dönemle karşılaştırma)
- [ ] Trend verileri aggregation sorguları (aylık/çeyreklik/yıllık)
- [ ] Intensity hesaplama tablosu (organization-level metrikler)

#### The Integrator Görevleri (Faz 2):
- [ ] Emissions Analytics → 5 tab'ın tüm API bağlantıları
- [ ] Reports → Rapor oluşturma engine
- [ ] Reports → PDF/Excel export (server-side rendering)
- [ ] Reports → Email paylaşım (Resend API)
- [ ] Bulk Upload → CSV/Excel parser + validation + batch insert
- [ ] Canlı hesaplama API entegrasyonu (Debounce 300ms ve frontend optimizasyonu)

#### The QA & Auditor Görevleri (Faz 2):
- [ ] Anomali tespiti senaryoları (geçmiş veriye göre %50+ sapma testi)
- [ ] Report data quality hesaplaması testleri
- [ ] Locked period immutability testleri
- [ ] E2E testler (tam kullanıcı akışı: giriş → veri gir → onayla → rapor oluştur)
- [ ] ISO 14064-1 uyumluluk kontrolü (scope eşlemesi, faktör doğruluğu)

#### The DevOps & Cloud Engineer Görevleri (Faz 2):
- [ ] Production (Canlı) ortam bulut altyapısının kurulması ve CDN/SSL konfigürasyonu
- [ ] GitHub Actions ile tam CI/CD boru hatlarının kurulması (Unit/E2E testlerin otomatik çalışması ve deploy)
- [ ] KVKK ve GDPR gereksinimlerine göre veri saklama ve Frankfurt bölgesi (EU-Central) veri izolasyonu ayarları
- [ ] Veritabanı otomatik yedekleme ve kurtarma (DR) planlarının kurulması

#### The Security & Compliance Engineer Görevleri (Faz 2):
- [ ] Tüm Scope 3 / supplier tabloları için RLS + guard kapsamının genişletilmesi
- [ ] Locked period immutability ve revizyon iş akışı güvenlik kontrolleri
- [ ] Yetki aşımı / penetrasyon senaryolarının (QA ile birlikte) doğrulanması
- [ ] Frankfurt (EU-Central) veri izolasyonu ve gizlilik denetiminin son hali

#### The Data & Emission Factor Engineer Görevleri (Faz 2):
- [ ] Scope 3 faktörleri ve AIB (EU residual mix) faktörlerinin seed'i
- [ ] Bulk upload için faktör eşleme ve veri kalite kurallarının tanımı
- [ ] Çoklu yıl/coğrafya faktör kütüphanesinin genişletilmesi + kaynak/lisans dokümantasyonu
- [ ] Intensity metrik hesaplamaları için referans veri setlerinin hazırlanması

---

## 11. Kritik İş Kuralları ve Kısıtlar

### 11.1 Hesaplama Kuralları
1. **Faktör Versiyonlama:** Her hesaplama, kullanılan faktörü ve versiyonunu kaydetmelidir
2. **Scope Eşlemesi:** Kategori → Scope eşlemesi sabittir ve değişmemelidir
3. **tCO₂e Birimi:** Tüm toplamlar ve raporlar tCO₂e (ton CO₂ eşdeğeri) cinsinden olmalıdır
4. **Data Quality Score:** Her kategori için 0-100 arası bir kalite puanı hesaplanmalıdır (kanıt sayısı, onay durumu, eksik alan sayısına göre)

### 11.2 Raporlama Kuralları
1. %15'ten fazla onaysız veri içeren raporlarda uyarı banner'ı gösterilmelidir
2. Rapor oluşturma işlemi `generation_log` tablosuna loglanmalıdır
3. Methodology Appendix, kullanılan tüm faktör kaynaklarını listelemelidir

### 11.3 Veri Bütünlüğü
1. İştirak silinirken ilişkili lokasyonlar, veri gönderileri ve emisyon kayıtları cascade silinmeli (veya soft-delete)
2. Kilitli dönemlerdeki veriler değiştirilemez (immutable)
3. Her veri değişikliği audit log'a yazılmalıdır

### 11.4 NACE Kodları
Sistem 31 NACE sektör kodu desteklemektedir (A01'den O84'e kadar). Bu kodlar iştirak oluşturma formunda zorunlu alandır.

### 11.5 Ülke Desteği
30 ülke tanımlıdır. Bu liste emisyon faktörü coğrafya eşlemesi için kullanılır.

---

## 12. Teknik Borç ve Dikkat Edilmesi Gerekenler

### 12.1 Mevcut Eksiklikler (Backend Tamamlamalı)

| Alan | Durum | Açıklama |
|------|-------|----------|
| **Global State Management** | ❌ Eksik | Zustand veya Context API ile kullanıcı session, yetki ve filtre state'leri yönetilmeli |
| **Authentication** | ❌ Mock | Supabase Auth entegrasyonu gerekli |
| **Internationalization (i18n)** | ❌ Yok | Türkçe/İngilizce çoklu dil altyapısı kurulmalı |
| **Pagination** | ❌ Yok | Tüm listeler client-side, backend pagination gerekli |
| **Error Handling** | ❌ Minimal | API hata yakalama, retry mekanizması ve kullanıcı bildirimi |
| **Loading States** | ⚠️ Kısmi | Sadece reports sayfasında var, tüm API çağrılarına eklenmeli |
| **Settings Sayfası** | ❌ Yok | Sidebar'da butonu var ama sayfası yok |
| **Bulk Upload** | ❌ Yok | CSV/Excel toplu veri yükleme UI ve backend mekanizması |
| **Supplier Management (Scope 3)** | ❌ Yok | Tedarikçi ESG skorları modülü tasarlanmalı |
| **Dark Mode** | ⚠️ Devre dışı | CSS değişkenleri tanımlı ama dark tema aynı light tema ile override edilmiş |
| **Mobile Responsive** | ⚠️ Kısmi | `use-mobile` hook var ama tam mobil uyumluluk test edilmemiş |

### 12.2 Mock Data → Gerçek Veri Geçişi

Frontend'deki mock veri dosyaları ve karşılık gelen API'ler:

| Mock Dosya | Gerçek API Karşılığı |
|-----------|---------------------|
| `lib/data.ts` → `subsidiaries`, `calculateKPIs()`, `alerts` | `/api/subsidiaries`, `/api/kpi/dashboard`, `/api/alerts` |
| `lib/emissions-data.ts` → `emissionsRecords`, `categoryEmissions`, `trendData`, `emissionsTargets` | `/api/emissions/*` |
| `lib/data-entry-data.ts` → `categoryFieldGroups`, `sampleSubmission` | `/api/data-entry/*` |
| `lib/subsidiaries-data.ts` → `SUBSIDIARIES` | `/api/subsidiaries` |

### 12.3 Performans Dikkat Noktaları

1. **Emissions sayfası (1316 satır):** Çok fazla inline bileşen ve hesaplama içeriyor. Backend tarafında aggregation yapılması kritiktir — tüm kayıtları frontend'e gönderip orada hesaplama yapmak ölçeklenmez.
2. **Trend verileri:** Backend materialized view veya önceden hesaplanmış aggregation tabloları kullanmalıdır.
3. **Canlı hesaplama önizlemesi:** Debounce (300ms) ile API çağrısı yapılmalı, her tuş vuruşunda istek gönderilmemelidir.

---

## 13. Riskler ve Risk Azaltma Planı (Risks & Mitigation)

Yarın projeye başlarken geliştirme ekibinin karşılaşabileceği teknik/mimari riskler ve bunları azaltma stratejileri aşağıda tanımlanmıştır:

### 13.1 Hesaplama Motoru Performansı ve Tutarlılığı
*   **Risk:** Binlerce lokasyondan veri girilirken emisyon faktörü aramalarının veritabanını yorması ve canlı hesaplama önizlemesinin yavaşlaması.
*   **Mitigation:** 
    *   Emisyon faktörleri (`emission_factors`) NestJS tarafında bellek içi önbelleğe (in-memory cache) alınacaktır.
    *   Her hesaplama sonucuna kullanılan faktör değeri ve versiyonu kaydedilecek, böylece geçmiş hesaplamaların bütünlüğü (`immutability`) veritabanı kilitleriyle korunacaktır.
    *   Hesaplama motoru formülleri için `Vitest` ile kapsamlı unit testleri yazılacaktır.

### 13.2 Büyük Boyutlu CSV/Excel Veri Yükleme (Bulk Upload) Yükü
*   **Risk:** Holdinglerin geçmiş yıllara ait on binlerce satırlık emisyon verisini yüklemesi sırasında sunucunun timeout'a düşmesi veya veritabanı işlemlerinin kilitlenmesi.
*   **Mitigation:**
    *   Dosya yüklemeleri arka planda asenkron kuyruk yapısı (NestJS BullMQ veya Supabase Edge Functions) ile işlenecektir.
    *   Kullanıcıya işlemin durumu (Processing/Completed) gösterilecek, hatalı satırlar anında raporlanacaktır.
    *   Veri geçerliliği (NACE kodları, kategori birimleri vb.) veritabanına yazılmadan önce `Papa Parse` ile client tarafında ön validasyondan geçirilecektir.

### 13.3 Yerelleştirme ve Sayı/Tarih Formatlama Karmaşası
*   **Risk:** Çok uluslu iştirak yapısında, Türkiye ve Avrupa lokasyonlarındaki sayısal formatların (nokta/virgül ayrımı) ve tarih biçimlerinin backend/frontend arasında yanlış yorumlanması.
*   **Mitigation:**
    *   Sistem genelinde `next-intl` kullanılacak ve tüm sayısal formatlama işlevleri merkezi helper fonksiyonlara (`utils.ts`) taşınacaktır.
    *   Veritabanında tarihler her zaman UTC (ISO 8601) formatında saklanacaktır.

### 13.4 Supabase RLS ve Rol Yetki Sızıntıları (Tenant Isolation Bypass)
*   **Risk:** Data Entry rolündeki bir kullanıcının, API isteklerini manipüle ederek yetkisi olmayan başka bir iştirak tesisinin verisini görmesi veya değiştirmesi.
*   **Mitigation:**
    *   Supabase veritabanında tüm tablolar için Row Level Security (RLS) politikaları zorunlu kılınacaktır.
    *   API katmanında NestJS Guard'ları ile JWT içerisindeki `accessibleSubsidiaryIds` kontrol edilecek, izinsiz erişim denemeleri otomatik olarak loglanıp engellenecektir (Audit Trail).

---

> **Son Söz:** Bu döküman, `carbon-dashboard-design` projesinin backend entegrasyonu için eksiksiz bir teknik kılavuz niteliğindedir. Yenilenen teknoloji kararları ve DevOps ajanı eklemesiyle birlikte yarın sabah geliştirme fazına başlamaya hazır durumdayız.
>
> **Hazırlayan:** Ana Yapay Zeka / Tech Lead & Software Architect
> **Tarih:** 2026-06-14
> **Revizyon:** v1.1
