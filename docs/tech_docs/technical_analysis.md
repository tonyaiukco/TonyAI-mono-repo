# TonyAI Kurumsal - Teknik Analiz ve Mimari Dokümanı

## 1. Yönetici Özeti (Executive Summary)
TonyAI, büyük holdinglerin ve çok uluslu şirketlerin alt iştirakleri ve lokasyonları (tesisleri) genelinde karbon emisyonlarını (Kapsam 1, 2, 3) takip etmelerini, hesaplamalarını ve denetime hazır (audit-ready) raporlar oluşturmalarını sağlayan kurumsal düzeyde bir ESG (Çevresel, Sosyal ve Kurumsal Yönetişim) ve sürdürülebilirlik yönetimi platformudur. 

Bu doküman, ürünün teknik gereksinimlerini, kullanılacak teknoloji yığınını (tech stack), mimari yaklaşımı ve ilerleyen aşamalarda projeyi insansız (otonom) bir şekilde geliştirecek "Subagent" takım yapısını tanımlamaktadır.

---

## 2. Sistem Mimarisi ve Temel Modüller

Ürün, modern bir **Headless (Başsız) Mimari** ile tasarlanacak olup, Frontend (Next.js/React) ve Backend (Hesaplama Motoru / API) arasında tamamen JSON tabanlı bir iletişim kurulacaktır.

**Kod Organizasyonu (Monorepo):** Headless ayrım korunmakla birlikte, tüm kod tek bir **Turborepo monorepo** içinde (`~/Repos/TonyAI-mono-repo`, pnpm workspaces) yönetilecektir:
- `apps/web` — Next.js önyüz (mevcut `carbon-dashboard-design` buraya taşınır)
- `apps/api` — NestJS backend (API + Hesaplama Motoru)
- `packages/shared-types` — frontend ve backend'in ortak kullandığı TypeScript tip tanımları (tek doğruluk kaynağı; mevcut `web/lib/types.ts`'ten çıkarılır)
- `packages/db` — Supabase migration ve seed dosyaları

Bu yapı, tip tutarlılığını garanti altına alır ve subagent'ların aynı repo üzerinde paralel çalışmasını mümkün kılar.

### Temel Sistem Modülleri:
1. **Global Context ve State Yönetimi:** Kullanıcının giriş yaptığı anda yetkilerini, erişebildiği organizasyon/iştirakleri ve aktif raporlama yılını belirleyen ana state yapısı.
2. **Dashboard (Genel Bakış) Modülü:** Veri eksikliklerini anında tespit eden "Tracking Matrix" (Kırmızı/Sarı/Yeşil durum göstergeli) ve üst düzey emisyon KPI'larını içeren yönetici ekranı.
3. **Akıllı Veri Girişi (Data Entry) Modülü:** Kapsam (Scope) bazlı dinamik formlar. Canlı hesaplama önizlemesi (Real-time calculation preview), kanıt (fatura vb.) yükleme ve anomali tespiti (geçmişe göre %50'den fazla sapma uyarıları) içerir.
4. **Hesaplama Motoru (Calculation Engine):** Kullanıcının lokasyonuna (TR, UK, EU vb.) ve raporlama yılına göre değişen emisyon faktörlerini (DEFRA 2023, DEFRA 2024 vb.) kullanarak dinamik tCO2e hesaplaması yapan motor. Sistem, geçmiş yıllara ait verilerin hesaplamalarının değişmemesi için kesin bir "Faktör Versiyonlama" (Factor Versioning) mantığıyla çalışacaktır.
5. **Organizasyon Yönetimi (Subsidiaries & Locations):** Holding > İştirak > Lokasyon hiyerarşisinin yönetildiği, raporlama sınırlarının (Reporting Boundaries) belirlendiği modül.
6. **Tedarikçi Yönetimi (Scope 3 - Suppliers):** Değer zinciri emisyonlarının takibi için tedarikçilerin ESG skorları ve SBTi (Bilimsel Tabanlı Hedefler) uyumluluklarının izlendiği alan.
7. **Raporlama ve Export Motoru:** Denetime hazır PDF, Excel ve CSV formatında veri çıktıları üreten jeneratör.

---

## 3. Teknoloji Yığını (Tech Stack) ve Kütüphane Kararları

Büyük veri setleri, yüksek performans gereksinimi ve kurumsal bir B2B SaaS hissi yaratmak için aşağıdaki kararlaştırılmış teknoloji yığını ve kütüphaneler kullanılacaktır:

### Frontend (Kullanıcı Arayüzü)
*   **Framework:** React 19 tabanlı **Next.js 16 (App Router)**. GCP/Azure üzerinde Docker container'lar ile host edilecektir.
*   **Styling & UI Components:** **Tailwind CSS v4** (Hızlı ve modern stillendirme) ve **Shadcn UI (New York stili)** (Kurumsal ve erişilebilir temel bileşen seti).
*   **Veri Görselleştirme:** **Recharts** (Frontend tasarımına uygun olarak Donut, Bar, Area, Treemap, Line ve Composed grafiklerinin çizimi için).
*   **İkonografi:** **Lucide React**.
*   **State Management:** **Zustand** (Global kullanıcı session, yetki sınırları ve dashboard filtre durumlarının performanslı yönetimi için).
*   **Yerelleştirme (Localization/i18n):** **next-intl** kütüphanesi kullanılarak Türkçe ve İngilizce dil desteği sağlanacaktır. Bölgesel sayı formatlama (decimal formatting) ve tarih biçimleri (`date-fns`) standartlaştırılacaktır.
*   **CSV/Excel İşlemleri (Client-side):** **Papa Parse** (CSV yüklemeleri ve hızlı okuma için).

### Backend (API & Hesaplama Motoru)
*   **Mimari:** **RESTful API (JSON)**. Endpoint'ler `/api/v1/` standardında versiyonlanacaktır.
*   **Dil/Framework:** **Node.js (NestJS)** (İlk faz için tip güvenliği, modüler yapı ve hızlı geliştirme avantajı sunar). İkinci fazdaki ileri düzey analitik tahminler ve yapay zeka entegrasyonları için bağımsız bir **Python (FastAPI)** mikroservisi sisteme eklenebilecektir.
*   **Veritabanı & Backend Servisleri:** **Supabase PostgreSQL** (Karmaşık ilişkisel veri modelleri ve RLS politikaları için).
*   **Kimlik Doğrulama (Auth):** **Supabase Auth** (JWT tabanlı oturum yönetimi ve rol bazlı yetkilendirme).
*   **Dosya Depolama (Storage):** **Supabase Storage** (Evidence/fatura dökümanları ve iştirak kapasite raporları için).
*   **Bildirimler:** **Resend** (E-posta bildirimleri ve anomali uyarıları için).
*   **Rapor Üretimi (Server-side PDF/Excel):** PDF raporlar için **Puppeteer** (sunucu tarafında headless Chrome ile HTML-to-PDF) veya **@react-pdf/renderer** kullanılacaktır. Excel export'ları için **exceljs** tercih edilecektir.

### Mühendislik ve Güvenlik Altyapısı
*   **Veritabanı Göçleri (Migrations):** Veritabanı şemasındaki değişiklikler Supabase DB Migrations altyapısı ile yönetilecek ve kod tabanında tutulacaktır.
*   **API Sınırlandırma (Rate Limiting):** API güvenliği ve kaynak koruması için NestJS Throttler modülü ile rate limiting uygulanacaktır.
*   **Önbellekleme (Caching):** Sıkça erişilen emisyon faktörleri (DEFRA vb.) ve statik tanımlamalar için bellek içi önbellekleme (NestJS cache-manager) kullanılacaktır.
*   **Hata İzleme (Error Tracking):** Hataların gerçek zamanlı takibi ve teşhisi için sisteme **Sentry** entegre edilecektir.
*   **Test Stratejisi:** Birim (unit) testleri için **Vitest**, uçtan uca (E2E) entegrasyon testleri için **Playwright** kullanılacaktır.

---

## 4. Güvenlik ve Yetkilendirme (RBAC)

Kurumsal veri gizliliği esastır. Sistem 4 temel rol üzerinden kurgulanacaktır:
*   **Super Admin:** Tüm holding hiyerarşisine hakim, faktör ve yapılandırma yöneticisi.
*   **Consultant (Danışman):** Atandığı şirketleri inceleyen, anomali işaretleyen onay makamı.
*   **Data Entry (Veri Giriş Uzmanı):** Sadece atandığı lokasyonlara veri ve kanıt girebilen temel kullanıcı.
*   **Executive Viewer (Yönetici İzleyici):** Sadece okuma/raporlama yetkisi olan C-Level kullanıcı.

**Önemli Güvenlik Kuralı:** Veriler Frontend'de filtrelenmekle kalmayıp, Backend'de de katı bir şekilde (Tenant Isolation) kullanıcının `accessibleSubsidiaryIds` sınırlarına göre korunacaktır. Kapalı raporlama dönemleri (Locked Periods) için veriler "Değiştirilemez" (Immutable) duruma getirilecek ve her düzenleme bir Audit Log'a (Denetim İzi) yazılacaktır.

**Çift Katmanlı İzolasyon (önemli netleştirme):** Tenant izolasyonunda **birincil enforcement NestJS guard'larıdır** — her sorgu, kullanıcının `accessibleSubsidiaryIds` sınırına göre backend (uygulama) katmanında zorlanır. **Supabase RLS politikaları ise ikincil savunma hattı (defense-in-depth)** olarak konumlanır: uygulama katmanında bir hata olsa bile veritabanı seviyesinde erişim reddedilir. İki katman birbirinin yerine geçmez, birlikte çalışır.

---

## 5. Otonom Takım Yapısı (Subagent Planlaması)

Bu devasa projeyi insansız ve paralel olarak geliştirebilmek için yazılım ekibini simüle edecek şu "Subagent" yapısını kurmayı öneriyorum:

### Agent 1: "The Architect" (Sistem Mimarı ve DB Uzmanı)
*   **Görev:** JSON Mock veri modellerini (Data Models) gerçek veritabanı şemalarına (Prisma / SQLAlchemy modellerine) dönüştürmek. API endpoint tasarımlarını ve RBAC (Yetki) middleware yapılarını kurmak. Calculation Engine (Hesaplama motoru) algoritmasını tasarlamak.

### Agent 2: "The UI/UX Engineer" (Frontend Geliştirici)
*   **Görev:** Next.js proje altyapısını kurmak. Shadcn UI ve Tailwind CSS ile Global Shell (Sidebar, Header vb.) yapısını oluşturmak. Dashboard, Tracking Matrix ve Responsive tasarım bileşenlerini birebir `ui_spec.md` ve `component_inventory.md` standartlarına uygun kodlamak.

### Agent 3: "The Integrator" (Full-Stack Geliştirici)
*   **Görev:** Frontend formlarını Backend API'leri ile bağlamak. Özellikle canlı hesaplama önizlemelerini (Real-time calculation preview), dosya yükleme işlemlerini (Evidence Upload) ve anomali tespit (Validation) kurallarını sisteme entegre etmek.

### Agent 4: "The QA & Auditor" (Test ve Kalite Güvence Uzmanı)
*   **Görev:** Anomali senaryoları, yetki aşım denemeleri, birim (unit) testler ve E2E (End-to-End) testler yazarak projenin ISO 14064-1 ve GHG protokolüne denetim açısından uygunluğunu sağlamak.

### Agent 5: "The DevOps & Cloud Engineer" (Bulut Altyapı ve DevOps Uzmanı)
*   **Görev:** Turborepo monorepo iskeletini kurmak. Supabase üzerinde Geliştirme (Development), Test (Staging) ve Canlı (Production) veritabanı ortamlarını kurmak. GitHub Actions ile otomatik CI/CD hatlarını yapılandırmak. Uygulamanın Docker konteynerlerini hazırlayarak GCP veya Azure üzerinde güvenli ve ölçeklenebilir şekilde canlıya almak. KVKK/GDPR uyumlu veri barındırma bölgelerini ayarlamak.

### Agent 6: "The Security & Compliance Engineer" (Güvenlik ve Uyumluluk Uzmanı)
*   **Görev:** Çok-kiracılı (multi-tenant) güvenliğin sahibi. RBAC rol/izin matrisini, Supabase RLS politikalarını ve NestJS tenant guard'larını (birincil enforcement) tasarlayıp uygulamak. Audit log değişmezliğini (immutability) ve kapalı dönem (locked period) kilitlerini garanti etmek. KVKK/GDPR veri yerleşimi ve gizlilik gereksinimlerini doğrulamak. Bu rol, daha önce QA içine sıkışmış olan kritik güvenlik sorumluluğunu ayrı bir uzmanlığa taşır.

### Agent 7: "The Data & Emission Factor Engineer" (Veri ve Emisyon Faktörü Uzmanı)
*   **Görev:** Domain-yoğun emisyon faktörü kütüphanesinin sahibi. DEFRA (UK), Türkiye Ulusal ve AIB (EU) faktörlerini kaynak/lisans bilgisiyle seed etmek; **faktör versiyonlama** (yıl + coğrafya bazlı, geçmiş hesaplamalar asla değişmez) ve **birim normalizasyonu** mantığını kurmak; metodoloji doğruluğunu (ISO 14064-1 / GHG Protocol) sağlamak. Hatalı faktör = yanlış rapor = uyumluluk riski olduğundan ayrı sahiplik gerektirir.

> **Orkestrasyon:** Bu 7 uzman subagent, **Ana Yapay Zeka / Tech Lead** tarafından koordine edilir; işleri parçalara böler, ilgili subagent'a atar, entegrasyonu ve kalite kontrolünü yürütür.

---

## 6. Sonraki Adımlar

Yukarıdaki analiz ve güncel kararlar (Supabase, GCP/Azure, Github, Figma ve Resend) doğrultusunda, projenin inşasına başlamak için izlememiz gereken yol haritası:
1.  **Altyapı Kurulumu:** `~/Repos/TonyAI-mono-repo` altında Turborepo monorepo'nun (pnpm workspaces; `apps/web`, `apps/api`, `packages/shared-types`, `packages/db`) kurulması, GitHub reposunun açılması, GCP veya Azure üzerinde projenin (Cloud Run / App Service vb.) yapılandırmasının yapılması ve Supabase (PostgreSQL + Auth) projesinin oluşturulması.
2.  **Temel Veri (Seed Data):** `data_models_and_json_mocks.md` dosyasındaki verilerin projeye mock olarak entegre edilmesi.
3.  **UI İnşası (Figma Destekli):** İletilecek Figma tasarımları referans alınarak, ilk olarak **Dashboard (Overview)** ve ardından **Data Entry** sayfalarının görsel olarak inşa edilmesi.
4.  **Fonksiyonalite:** Hesaplama motorunun bağlanması ve test edilmesi. Resend ile e-posta bildirimlerinin entegrasyonu.
5.  **Aşamalama Stratejisi (Phasing):** Ürünü en hızlı şekilde pazara sunmak ve test etmek için geliştirme; önce bir doğrulama dilimi, ardından iki faza ayrılacaktır:
    *   **İlk Milestone — İnce Dikey Dilim (Vertical Slice):** Tek bir akışı uçtan uca canlı veriyle çalıştırarak entegrasyon, RBAC ve deploy riskini en başta çözmek hedeflenir: Supabase Auth + login ekranı (önyüzde henüz yok) → `subsidiaries`/`locations`/RBAC/`audit_log` şeması → NestJS `/subsidiaries` CRUD + `/kpi` + tenant guard → önyüzde `lib/api.ts` + Zustand → Subsidiaries ve Dashboard sayfalarının mock'tan gerçek veriye geçişi → staging deploy + Playwright smoke testi.
    *   **Faz 1 (MVP - En Düşük Kabul Edilebilir Ürün):**
        *   Supabase veritabanı kurulumu (Dev/Staging) ve temel şemaların (iştirak, lokasyon, faktörler, submissions) oluşturulması.
        *   Global Context (Zustand) ve Supabase Auth entegrasyonu.
        *   Overview Dashboard: KPI kartları, iştirak veri tablosu ve detaylı iştirak sheet paneli.
        *   Data Entry: Scope 1 ve Scope 2 (Elektrik, Doğalgaz, Yakıt) form şemaları, kanıt (evidence) yükleme ve temel hesaplama motoru (canlı önizleme dahil).
        *   Organizasyon Yönetimi: Holding > İştirak > Lokasyon CRUD operasyonları.
        *   Birim (Unit) testleri (hesaplama motoru) ve temel RLS güvenlik politikaları.
    *   **Faz 2 (Advanced - Gelişmiş Özellikler):**
        *   Scope 3 (Satın alınan mallar, seyahat, lojistik vb.) formlarının ve emisyon faktörlerinin entegre edilmesi.
        *   Tedarikçi Yönetimi (Scope 3 Tedarikçi ESG Skorları) modülü.
        *   Gelişmiş Emissions Analytics: Breakdown (Treemap), History (Audit Ledger), Targets ve Trends sekmeleri.
        *   Gelişmiş Raporlama ve Dışa Aktarma: PDF ve Excel formatında denetime hazır raporların oluşturulması (Puppeteer/exceljs), Resend ile paylaşım.
        *   Gelişmiş Anomali Tespiti: Önceki dönemlere göre yüksek sapma tespiti (%50+).
        *   Toplu Veri Yükleme (Bulk Upload): Geçmiş yılların verilerinin CSV/Excel ile toplu aktarımı (Papa Parse ve sunucu tarafında kuyruk/worker altyapısı).
        *   Playwright ile E2E entegrasyon testleri ve Production ortamı (GCP/Azure) dağıtımı.
        *   İleri analitik/tahminleme için **Python (FastAPI) mikroservisi** ve UI **dark mode**, MVP kritik yolunda olmadığından bu faza ertelenmiştir.

**Sonuç:** Bu teknik analiz ve mimari yol haritası onaylandığı takdirde, 7 kişilik subagent ekibiyle ilerleyeceğiz: ilk olarak DevOps & Cloud Engineer ajanını görevlendirip monorepo + altyapı (GitHub, Supabase, Docker) hazırlıklarını başlatacak; Security & Compliance Engineer ile RLS/RBAC temelini ve Data & Emission Factor Engineer ile faktör kütüphanesini kuracağız. Ardından UI/UX Engineer ile mevcut önyüzü monorepo'ya taşıyıp **İnce Dikey Dilim** milestone'una geçeceğiz.
