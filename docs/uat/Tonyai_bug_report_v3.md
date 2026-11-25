# TONYAI — Birleşik Bug Raporu ve Hesaplama Spec'i (v3)

| | |
| :-- | :-- |
| **Birleştirme tarihi** | 20 Kasım 2026 |
| **Kaynak 1** | `TONYAI-MASTER-COMP-v2.4` — Hesaplama Motoru Mantığı ve UAT Test Çıktıları (16 Kasım 2026) |
| **Kaynak 2** | `TONYAI-INC-2.5-01` — Artış Spec'i: Doğalgaz kWh Girişi + Öz-Üretim (16 Kasım 2026) |
| **Onaylayanlar (v2.4)** | Nebil Arda Gökceviz (CEO / `super_admin`) & İsmet Emrecan Kapusuz (COO / `consultant`) |
| **Onay durumu (v2.5)** | Kaynak belgede onaylayan bilgisi yok — v2.5 bölümleri henüz mühürlü sayılmamalı |
| **Kapsam** | Mühürlü hesaplama mantığı + altın vektörler + UAT 1. ve 2. Etap bulguları + mimari kararlar (`K1–K5`, `S1–S3`) + v2.5 artışları (doğalgaz kWh girişi, öz-üretim Case A) |

---

## 0. Birleştirme Notu

- **Ana iskelet v2.4'tür.** v2.5 belgesi v2.4'ün *üstüne eklenen* bir artış olduğu için ilgili bölümlere yerleştirildi: hesap kuralları §1'e, golden vektörler §2'ye, iş kalemleri §3'e, kararlar §4'e.
- v2.4'teki hesap zinciri, golden vektörler (GV-1 .. GV-8) ve UAT kararları **değiştirilmedi**.
- Formül ve sayılar kaynaklardaki gibidir. Yalnızca biçim değişti: v2.4'teki LaTeX gösterimi, her iki belge tek tip olsun diye düz metne çevrildi.
- v2.5 belgesinde bug ID'si yoktu. §3.3'teki iş kalemleri v2.5'in metninden **türetilmiştir** ve yeni ID atanmamıştır.
- İki belge arasında birleştirme sırasında fark edilen tutarsızlıklar ve açık noktalar §5'te toplandı.

---

## 1. Hesaplama Motoru Mantığı (`Calculation Engine Core Logic`)

### 1.1. Genel Hesaplama Zinciri ve Sabitler

- **Ana zincir:** Miktar → Enerji (TJ, Net CV) → Gaz bazlı emisyon (kg CO₂, CH₄, N₂O ayrı) → × GWP (AR6) → tCO₂e
- **Birim sabitleri:**
  - 1 kcal = 4,184 kJ
  - 1 TJ = 10⁹ kJ
  - kcal → TJ çarpanı = 4,184 × 10⁻⁹
  - 1 kWh = 3,6 × 10⁻⁶ TJ
  - 1 MWh = 1.000 kWh
- **GWP seti (IPCC AR6 — 100 yıl):** CO₂ = 1 · N₂O = 273 · CH₄ (yanma / fosil) = 27,0 · CH₄ (kaçak / fugitive) = 29,8 *(legacy 27,9 aktif hesapta kullanılmaz)*
- **Fail-closed kuralı:** (geography + year + category + cvBasis) eşleşmesi yoksa veya Brüt (GCV) × Net EF kombinasyonu denenirse sistem sessiz fallback yapmaz; `HTTP 422` döner.

### 1.2. Modül Bazlı Formüller ve Kurallar

| Modül | Scope | Hesaplama formülü ve iş kuralı | Emisyon faktörleri ve parametreler (`TR`) |
| :-- | :--: | :-- | :-- |
| **Sabit Yanma — Doğalgaz** (`Natural Gas`) | 1 | **1.** Birim m³ ise: Sm³ = m³ × VCF<br>**2.** Enerji (TJ) = Sm³ × NCV × 4,184 × 10⁻⁹<br>**3.** *(BOTAŞ GCV düzeltmesi varsa: NCV_efektif = 8.250 × (9.155 / GCV_fatura))*<br>**4.** Birim kWh (doğal gaz) ise `cvBasis=NET` zorunlu: TJ = kWh × 3,6 × 10⁻⁶ *(giriş kuralları için bkz. §1.3)*<br>**5.** tCO₂e = TJ × (EF_CO₂ × 1 + EF_CH₄ × 27,0 + EF_N₂O × 273) / 1.000 | **Varsayılan NCV:** 8.250 kcal/Sm³ *(sabit dolu gelir, elle revizyona açıktır)*<br>**IPCC 2006 Net EF (kg/TJ):** CO₂ = 56.100 · CH₄ = 1,0 · N₂O = 0,1<br>*(Birleşik: 56.154,3 kgCO₂e/TJ)* |
| **Sabit Yanma — Diğer Yakıtlar** | 1 | Kütle (kg) = Miktar (L) × Yoğunluk (kg/L) *(birim kg ise doğrudan)*<br>Enerji (TJ) = Kütle (kg) × NCV (kcal/kg) × 4,184 × 10⁻⁹ | **Dizel:** ρ=0,83, NCV=10.200, EF=74.100 / 3 / 0,6<br>**Benzin:** ρ=0,735, NCV=10.400, EF=69.300 / 3 / 0,6<br>**LPG:** ρ=0,56, NCV=10.900, EF=63.100 / 1 / 0,1<br>**Kömür:** NCV=6.100, EF=98.300 / 10 / 1,5<br>**Fuel Oil:** NCV=9.600, EF=77.400 / 3 / 0,6<br>*(EF sırası: CO₂ / CH₄ / N₂O, kg/TJ)* |
| **Hareketli Yanma** (`Mobile Combustion`) | 1 | **Araç modu seçimi zorunludur** (`ON ROAD` / `OFF ROAD` / `MGO`).<br>Enerji (TJ) = Litre × ρ (kg/L) × NCV (kcal/kg) × 4,184 × 10⁻⁹<br>tCO₂e = TJ × (EF_CO₂ × 1 + EF_CH₄ × 27,0 + EF_N₂O × 273) / 1.000 | **On-Road Benzin:** ρ=0,735, NCV=10.400, EF=69.300 / 25 / 8 (≈ 2,3078 kgCO₂e/L)<br>**On-Road Dizel:** ρ=0,830, NCV=10.200, EF=74.100 / 3,9 / 3,9 (≈ 2,6684 kgCO₂e/L)<br>**On-Road LPG:** ρ=0,560, NCV=10.900, EF=63.100 / 62 / 0,2<br>**Off-Road Dizel:** EF=74.100 / 4,15 / 28,6<br>**MGO:** Deniz taşıtları |
| **Şebeke Doğalgaz Kaçağı** (`Fugitive Gas`) | 1 | Yoğunluk ve CH₄ oranı kullanıcıya **kapalıdır (sabit)**.<br>Sm³(0°C) = Stdm³ × 273/288<br>kg CH₄ = Sm³(0°C) × 0,7409 × 0,92<br>tCO₂e = kg CH₄ × 29,8 / 1.000 (CO₂ = 0, N₂O = 0) | **Sıcaklık düzeltmesi:** 273/288 = 0,9479167<br>**Yoğunluk:** 0,7409 kg/Sm³<br>**CH₄ oranı:** 0,92 (%92)<br>**AR6 kaçak GWP:** 29,8 |
| **Soğutucu ve Söndürme Gazları** (`Refrigerants`) | 1 | **Yalnızca yıllık** girilir.<br>Kaçak (kg) = (Kurulu Kapasite (kg) × Kaçak Oranı %) + Yıllık Dolum (kg)<br>tCO₂e = Kaçak (kg) × GWP_AR6 / 1.000 | **Varsayılan kaçak oranları:** Yangın Söndürme Sistemi %2, Tüp %4, Trafo SF₆ %0,01, Klima %1 (%10), Su Sebili/Buzdolabı %0,1, Chiller %2 (%8), Araç Kliması %15<br>**AR6 GWP:** FM200=3.600, R-410A=2.256, R-134a=1.530, R-32=771, R-404A=4.728, SF₆=25.200 |
| **Şebeke Elektriği** (`Scope 2 Dual`) | 2 | **Birim:** kWh (elektrik) veya MWh (elektrik) *(doğalgaz kWh'ten ayrı)*<br>**Location-based:** tCO₂e = kWh × EF_yıl / 1.000<br>**Market-based:** (Sertifikalı kWh × 0) + (Kalan kWh × EF_tedarikçi/şebeke). Market verisi yoksa "Piyasa bazlı sonuç bulunmamaktadır" basılır.<br>*(Öz-üretimli tesislerde Scope 2 temeli için bkz. §1.4)* | **ETKB TR ulusal şebeke EF:**<br>• 2024: 0,442 kgCO₂e/kWh<br>• 2025: 0,434 kgCO₂e/kWh<br>• 2026: 0,434 kgCO₂e/kWh (`D07` onaylı yedek yıl beyanıyla) |

### 1.3. Doğalgaz kWh Girişi (v2.5 §1)

#### 1.3.1. Mevcut durum
Motor doğalgaz kWh'ini zaten işleyebiliyor (§1.2 doğalgaz kuralı #4: `cvBasis=NET` zorunlu, TJ = kWh × 3,6 × 10⁻⁶). Eksik olan tek şey **veri giriş formu**: doğalgaz şu an yalnız `m³` ve `Sm³` kabul ediyor. `kWh (doğal gaz)` birimi BUG-04'te elektrik kWh'inden zaten ayrılmıştı; şimdi doğalgaz tarafında da açılacak.

#### 1.3.2. Yön kuralı (kritik — ters çevirme yok)
kWh zaten enerjidir. **kWh'i hacme (Sm³/m³) geri çevirme.** Motor birime göre farklı giriş kapısı seçer:

| Giriş birimi | Zincir | Not |
| :-- | :-- | :-- |
| `Sm³` | Sm³ × NCV × 4,184 × 10⁻⁹ → TJ | Mevcut (v2.4) |
| `m³` | m³ × VCF → Sm³, sonra Sm³ yolu | Mevcut (v2.4) |
| `kWh (doğal gaz)` | **NCV adımını atla** → TJ = kWh × 3,6 × 10⁻⁶ → EF | NCV'ye bağlanma, hacme dönme |

#### 1.3.3. Brüt/Net CV — zorunlu UX kuralı
Faturadaki doğalgaz kWh'i neredeyse her zaman **brüt (GCV)**; motorun EF'i **net**. Fail-closed kuralı brüt-kWh × net-EF kombinasyonunu `HTTP 422` ile zaten reddediyor. Kullanıcıyı 422 duvarına toslatmak yerine formda çözülecek:

1. `kWh (doğal gaz)` seçilince `cvBasis` (**NET / BRÜT**) alanı **zorunlu** görünür.
2. **NET** seçilirse: doğrudan hesap.
3. **BRÜT** seçilirse: otomatik düzeltme sunulur —
   - faturada GCV varsa: `kWh_net = kWh_brüt × (NCV_ref / GCV_fatura)`, ya da
   - yoksa varsayılan: `kWh_net ≈ kWh_brüt × 0,9`.

   Düzeltme kullanıcıya açıkça gösterilir; ham 422 yalnız `cvBasis` boş bırakılırsa kalır (sessiz varsayım yok).

### 1.4. Öz-Üretim / Self-Generation — Case A (Behind-the-Meter, Net Sayaç) (v2.5 §2)

#### 1.4.1. Temel prensip
Üç değişmez kural; motor bunlara göre kurulmalı:

1. **Scope 2 = yalnızca gridden NET çekilen kWh × yıllık EF.** Faturadaki brüt rakam değil, öz-tüketilen öz-üretim değil.
2. **Öz-üretimin karbonu kaynağına bağlıdır:** yenilenebilir (güneş/rüzgâr) → doğrudan emisyon **sıfır**; yakıtlı (doğalgaz kojen / dizel jeneratör) → emisyon **yakıttan** (Scope 1), ürettiği kWh'ten değil.
3. **Çift sayım yasağı:** yakıtlı öz-üretimin yakıtı Scope 1'de sayılır; ürettiği kWh Scope 2'ye **hiç girmez**.

#### 1.4.2. Topoloji kapsamı
Bu iterasyon **yalnız Case A**: üretim yerinde tüketilir, fazlası şebekeye verilir, açık şebekeden alınır; sayaç **net alışverişi** görür. Alan modeli B ve C'yi de kaldıracak şekilde kurulur ama bu turda **kapatılır (not implemented)**:

- **Case B** (üretimin tamamı şebekeye basılıp geri çekilir — mahsuplaşma/satış): fatura **brüt** gösterebilir; `exportedToGridKwh` zorunlu hale gelir. → Sonraki tur.
- **Case C** (ada / off-grid): `gridNet = 0`, her şey Scope 1 ya da sıfır. → Sonraki tur.

> Alan modeli ileriye uyumlu olsun diye `generationTopology` enum'u (A | B | C) baştan konur; bu turda yalnız A seçilebilir, B/C disabled.

#### 1.4.3. Veri alanları (Case A)

| Alan | Zorunlu? | İşlevi |
| :-- | :-- | :-- |
| `generationTopology` | zorunlu (bu turda sabit `A`) | İleriye uyumluluk |
| `selfGenerationSource` | **zorunlu** | Scope ve faktörü belirler (solar/wind → 0; natural_gas/diesel → Scope 1). **Kaynak bilinmeden Scope atanamaz.** |
| `selfGeneratedKwh` | zorunlu | Enerji dengesi + market-based iz |
| `gridFromKwh` (fatura net çekilen) | zorunlu | **Scope 2 location temeli** |
| `exportedToGridKwh` | opsiyonel (A'da genelde düşük) | Enerji dengesi; Scope'u azaltmaz |
| `generationFuelType` + `generationFuelQuantity` (Sm³ / L) | yakıtlı kaynakta **zorunlu** | **Scope 1** (Sabit Yanma modülüne gider) |
| Fatura (PDF) | zorunlu (`K3`) | Kanıt + denge doğrulaması |

#### 1.4.4. Emisyon eşlemesi

| Üretim kaynağı | Scope 1 | Scope 2 (location) | Öz-üretilen kWh |
| :-- | :-- | :-- | :-- |
| Güneş / rüzgâr | 0 | `gridFromKwh × EF_yıl` | 0 (totale girmez) |
| Doğalgaz kojen | yakıttan (Sabit Yanma) | `gridFromKwh × EF_yıl` | Scope 2'ye **girmez** |
| Dizel jeneratör | yakıttan (litre dizel) | `gridFromKwh × EF_yıl` | Scope 2'ye **girmez** |

**Kaçınılan emisyon (avoided):** yenilenebilir öz-tüketim sayesinde kaçınılan miktar (`öz-tüketilen × EF`) istenirse raporda **"bilgi amaçlı / avoided"** gösterilir ama Scope 1/2/3 **toplamlarına eklenmez**. Scope 2 asla negatif olamaz.

#### 1.4.5. Enerji dengesi (motor validation)
```
gridNet = tesisTüketimi − selfGeneratedKwh + exportedToGridKwh
```
Girilen `gridFromKwh` bu denge ile tutarsızsa motor **uyarır** (bloke etmez; `K4` anomali mantığıyla aynı ruhta — `rejected → draft` akışı). "Veri eksiği yaşamadan" hedefi burada karşılanır: form kaynağa göre doğru alanları açar, dengeyi kontrol eder.

#### 1.4.6. Market-based not
Case A'da öz-tüketilen yenilenebilir, sertifikalıysa (I-REC / YEK-G) market-based Scope 2'de **sıfır faktörlü ayrı satır** olarak kredilenebilir; location-based yine fiziksel `gridFromKwh`'i yansıtır. İkisi Scope 2 Dual şemasındaki `greenElectricityShare` + `selfGenerationKwh` alanlarıyla taşınır. (B senaryosunda location ve market belirgin şekilde ayrışır — o yüzden B sonraki tura bırakıldı.)

---

## 2. Mühürlü Altın Test Vektörleri (`Golden Vectors` — tolerans ±%0,5)

### 2.1. v2.4 vektörleri (GV-1 .. GV-8)

| # | Kategori | Yıl / Ülke | Girdi miktarı ve birim | Dönüşüm / parametre özeti | Beklenen sonuç (tCO₂e) | Kabul aralığı (±%0,5) |
| :--: | :-- | :--: | :-- | :-- | :--: | :--: |
| **GV-1** | `Electricity` | 2025 ve 2026 (`TR`) | 4.180,56 kWh | Doğrudan × 0,434 kgCO₂e/kWh | **1,814 tCO₂e** (1.814,36 kg) | 1,805 – 1,823 |
| **GV-2** | `Electricity` | 2024 (`TR`) | 4.180,56 kWh | Doğrudan × 0,442 kgCO₂e/kWh | **1,848 tCO₂e** (1.847,81 kg) | 1,839 – 1,857 |
| **GV-3** | `Natural Gas` | 2025 (`TR`) | 73,953103 Sm³ | Efektif NCV = 8.078,67 (veya 8.080) kcal/Sm³ → 0,002500 TJ | **0,1404 tCO₂e** (140,37 kg) | 0,1397 – 0,1411 |
| **GV-4** | `Natural Gas` | 2025 (`TR`) | 100,00 Sm³ | Varsayılan sabit NCV = 8.250 kcal/Sm³ → 0,0034518 TJ | **0,1938 tCO₂e** (193,83 kg) | 0,1928 – 0,1948 |
| **GV-5** | `Mobile (On-Road Gasoline)` | 2025 (`TR`) | 15.973,75 Litre | × 0,735 × 10.400 × 4,184 × 10⁻⁹ = 0,51088 TJ | **36,8646 tCO₂e** (36.864,62 kg) | 36,6803 – 37,0489 |
| **GV-6** | `Mobile (On-Road Diesel)` | 2025 (`TR`) | 3.784,51 Litre | × 0,830 × 10.200 × 4,184 × 10⁻⁹ = 0,13405 TJ | **10,0902 tCO₂e** (10.090,24 kg) | 10,0397 – 10,1407 |
| **GV-7** | `Fugitive Gas Leakage` | 2025 (`TR`) | 84.783,36 Stdm³ | × 273/288 × 0,7409 × 0,92 = 54.780,78 kg CH₄ × 29,8 | **1.632,47 tCO₂e** *(27,9 ile 1.528,38 = HATA)* | 1.624,31 – 1.640,63 |
| **GV-8** | `Refrigerants (FM200)` | 2025 (`TR`) | 40,00 kg | Yangın Söndürme Sistemi (× %2 kaçak = 0,8 kg) × 3.600 GWP | **2,8800 tCO₂e** (2.880,00 kg) | 2,8656 – 2,8944 |

### 2.2. v2.5 vektörleri — Doğalgaz kWh (birleşik EF 56.154,3 kgCO₂e/TJ)

| # | Girdi | Zincir | Beklenen | Kabul aralığı |
| :-- | :-- | :-- | :-- | :-- |
| **GV-NG-kWh-A** | 1.000 kWh (NET) | × 3,6×10⁻⁶ = 0,0036 TJ | **0,2022 tCO₂e** (202,16 kg) | 0,2011 – 0,2032 |
| **GV-NG-kWh-B** | 1.000 kWh (BRÜT) | × 0,9 = 900 kWh net → 0,00324 TJ | **0,1819 tCO₂e** (181,94 kg) | 0,1810 – 0,1828 |
| **GV-NG-kWh-C** | 958,83 kWh (NET) | ≈ 100 Sm³ @ NCV 8.250 | **0,1938 tCO₂e** | 0,1928 – 0,1948 |

> **GV-NG-kWh-C**, **GV-4 (100 Sm³) ile çapraz doğrulama** için bilinçli olarak eklendi: aynı enerji, farklı birim, aynı sonuç. Motor kWh ve Sm³ yollarında ±%0,5 içinde örtüşmeli — örtüşmezse birim dönüşümünde hata var demektir.

### 2.3. v2.5 vektörleri — Öz-Üretim (TR-2025, EF 0,434)

| # | Senaryo | Girdi | Beklenen | Not |
| :-- | :-- | :-- | :-- | :-- |
| **GV-SG-1** | Saf solar (A) | Tüketim 1.000.000 kWh; solar öz-üretim 400.000; gridFrom 600.000 | **Scope 2 = 260,40 tCO₂e** (600.000 × 0,434); **Scope 1 = 0** | Öz-tüketilen 400.000 totale girmez |
| **GV-SG-2** | Doğalgaz kojen (A) | gridFrom 600.000 kWh + üretim yakıtı 500.000 Sm³ doğalgaz (NCV 8.250) | **Scope 2 = 260,40 tCO₂e**; **Scope 1 = 969,17 tCO₂e** (yakıttan) | Üretilen kWh Scope 2'ye girmez; S1+S2 = 1.229,57 t |
| **GV-SG-3** | Avoided (bilgi amaçlı) | Saf solar; öz-tüketilen 400.000 kWh | **Avoided = 173,60 tCO₂e** (400.000 × 0,434) | **Toplamlara EKLENMEZ**, yalnız raporda bilgi |

GV-SG-2 Scope 1 türetimi: `500.000 × 8.250 × 4,184×10⁻⁹ = 17,259 TJ × 56.154,3 = 969.167 kg = 969,17 tCO₂e` (Sabit Yanma — Doğalgaz zinciri, §1.2).

Hiçbir v2.5 vektörü v2.4'tekilerle çakışmaz; GV-NG-kWh-C bilerek GV-4'e bağlıdır.

---

## 3. Birleştirilmiş Bulgu ve İş Kalemi Tabloları (`Consolidated Bug Tracker`)

### 3.1. UAT 1. Etap Bulguları (`BUG-01` .. `BUG-10`)

| ID | Öncelik | Modül | Özet bulgu | Durum / çözüm kuralı |
| :-- | :--: | :-- | :-- | :-- |
| **BUG-01** | **P1** | Veri Girişi — Elektrik | `TR` 2024, 2025, 2026 yıllarında "No emission factor found" hatası. | `TR` faktörleri (0,442 ve 0,434) yüklendi; 2026 uyarısı kaldırıldı. |
| **BUG-02** | **P1** | Veri Girişi — Doğalgaz | `TR` 2025 doğalgazda "No emission factor found" hatası. | IPCC 2006 Net-CV faktörleri (56.100 / 1 / 0,1) yüklendi. |
| **BUG-03** | **P1** | Doğalgaz Sm³ Birimi | Sm³ seçildiğinde *"Faz 4'te gelecek"* uyarısı çıkması. | Uyarı kaldırıldı; Sm³ → TJ (Net CV) zinciri ve 8.250 varsayılan NCV bağlandı. |
| **BUG-04** | **P1** | Birim Seçimi (`kWh`) | "kWh (elektrik / gaz)" biriminin tek satırda birleşik olması. | kWh (elektrik) ve kWh (doğal gaz) olarak ayrılması ve kategori bazlı filtreleme. *(Doğalgaz kWh girişinin forma açılması için bkz. §3.3)* |
| **BUG-05** | **P2** | Şirket ve Tesis Adresi | Statik `TR/UK` dropdown kullanılması, gerçek konumun bilinmemesi. | **2. Etapta devam ediyor (`BUG-R2-10`):** Google Places / Mapbox entegrasyonu yapılacak. |
| **BUG-06** | **P2** | Faaliyet Değeri Kutusu | `178,` yazarken anında kırmızı hata vermesi. | Virgül (`,`) kullanımı onaylandı; validasyon `onBlur` / 300 ms debounce sonrasına alındı. |
| **BUG-07** | **P2** | Alt Lokasyon Modalı | Alt lokasyon ekleme penceresinde dikey `scroll` çıkmaması. | Modala `overflow-y: auto` dikey kaydırma eklendi. |
| **BUG-08** | **P2** | Raporlama Yılı Listesi | Yıl listesinde 2074'e kadar yılların çıkması. | Yalnızca aktif envanter yılları (2024, 2025, 2026) ile sınırlandırıldı. |
| **BUG-09** | **P3** | Login Ekranı | Şifre alanında "Göster/Gizle" (göz) ikonu olmaması. | Şifre görünürlük ikonu eklenecek. |
| **BUG-10** | **P3** | Tarayıcı Sekmesi | Tarayıcı `<title>` ve `favicon` alanlarının eksik olması. | TonyAI kurumsal başlığı ve logosu eklenecek. |

### 3.2. UAT 2. Etap Yeni Bulguları (`BUG-R2-01` .. `BUG-R2-12`)

| ID | Öncelik | Modül / Ekran | Gözlenen hata (2. Etap çıktısı) | Beklenen davranış ve alınan karar referansı |
| :-- | :--: | :-- | :-- | :-- |
| **BUG-R2-01** | **P1** | Kullanıcılar ve RBAC | **1.** Bir e-posta aynı grup içindeki birden fazla bağlı şirkete atanamıyor.<br>**2.** Tek kullanıcıyla testte `super_admin` kendi kaydını onaylayamıyor. | **1.** Aynı holding içinde çoklu Bağlı Şirket (`Multi-select Subsidiary`) ataması UI'da açılacak (**`K1-A` kararı**).<br>**2.** Dört göz (`D01`) korunacak; testte 2 ayrı hesap kullanılacak (**`K2-A` kararı**). |
| **BUG-R2-02** | **P1** | Kanıt Doküman (`PDF`) | Doğalgazda kanıt doküman zorunluyken, Hareketli Yanma kanıtsız gönderilebiliyor; bazı kalemlerde yükleme kutusu çıkmıyor. | **Tüm emisyon kategorilerinde** (Elektrik, Doğalgaz, Hareketli Yanma, Sabit Yakıt, Kaçak, Soğutucu) `Submit` öncesi kanıt doküman (PDF) zorunlu olacak (**`K3` kararı**). *(v2.5 öz-üretim kayıtlarında da fatura PDF zorunlu — bkz. §1.4.3)* |
| **BUG-R2-03** | **P1** | Veri Girişi ve İnceleme | Girilmiş bir kayıtta tam kapsamlı düzenleme (`Edit`) yapılamıyor. | Kayıt üzerinde **Rakam, İşletme/Lokasyon, Emisyon Tipi, Yıl ve Dönem/Tarih** alanlarını değiştiren `Edit` fonksiyonu açılacak. |
| **BUG-R2-04** | **P1** | Kurumsal Hiyerarşi ve Wording | Sadece *"Bağlı şirket ekle"* var; **Ana Şirket**, **Bağlı Şirket** ve **İşletme/Tesis** kavramları ayrışmıyor. | 3 katmanlı net yapı (**`K1-A` kararı**): **1. Ana Şirket / Bağımsız Şirket (`Tenant`)** → **2. Bağlı Şirket (`Subsidiary`)** → **3. İşletme / Tesis (`Location`)**. |
| **BUG-R2-05** | **P2** | Veri Girişi Ekran Düzeni | Ekran dağınık, girilen veriler tek tabloda görülemiyor; 2. kutu olarak Toplu Yükleme çıkıyor. | Kutu sırası: **1. Raporlama Kapsamı** → **2. Faaliyet Verisi** → **3. Kanıt Doküman** → **4. Ek Bağlam / Toplu Yükleme** + altta **Birleşik Özet Tablo**. |
| **BUG-R2-06** | **P2** | Dashboard ve m³ Ölü Linkler | **1.** Dashboard sarı `0` hücresindeki "Ayrıntılar için tıklayın" linki çalışmıyor.<br>**2.** Doğalgaz m³ VCF açıklama detayı tıklanmıyor. | Her iki ölü link (`dead link`) düzeltilecek; Dashboard linki doğrudan ilgili kayda/inceleme ekranına yönlendirecek. |
| **BUG-R2-07** | **P2** | Anomali Kontrolü (`Cold-Start`) | İnceleme ekranında *"En az 3 dönem geçmiş olmalı"* diyerek kontrolü kapatıyor. | **Kademe 1:** ≥ 3 dönem (±%50). **Kademe 2:** 1–2 dönem kıyaslaması. **Kademe 3 (0 dönem):** *"İlk dönem kaydı, kanıtı kontrol edin"* uyarısı + typo tavanları (**`K4` kararı**). |
| **BUG-R2-08** | **P2** | Soğutucu Akışkanlar Çoklu Gaz | Farklı gaz/ekipmanlar (`R-410A` Klima ile `R-32` Chiller) tek seferde girilemiyor. | **Hemen (`K5-A`):** Tek kanıt dosyasını diğer gaz kayıtlarına bağlama UI'da öne çıkarılacak. **Sonraki adım (`K5-B`):** Tek formda çoklu gaz satırı girip arka planda gaz başına kayıt üretme. |
| **BUG-R2-09** | **P2** | Faktör Kütüphanesi (`UK`) | Faktörler sadece `TR` için var; `UK` seçildiğinde faktör yok uyarısı veriyor. | `UK` (DESNZ) faktörleri yüklenecek; arayüzde kapsam lejantı (`Legend`) gösterilecek. |
| **BUG-R2-10** | **P2** | Harita / Geolocation | Coğrafi konum / harita servisleri hâlâ aktif değil. | Şirket ve İşletme/Tesis adreslerinde harita servisi (otomatik `lat/lng` ve ülke kodu) aktif edilecek. |
| **BUG-R2-11** | **P2** | Hareketli Yanma — `MGO` | Hareketli yanmada `MGO (Marine Gas Oil)` yakıt seçeneği yok. | `MGO` hem `TR` hem `UK` için **Hareketli Yanma** altında eklenecek (**`S3-a` kararı**). |
| **BUG-R2-12** | **P3** | Dashboard Uyarı Metni | Geri çekilmiş veride *"hiçbir şeye sayılmaz"* yazıyor. | Metin ***"Geri çekilmiş veri hesaplamaya dahil edilmedi"*** olarak güncellenecek. |

### 3.3. v2.5 Kaynaklı İş Kalemleri

> v2.5 belgesinde bug ID'si yok; aşağıdaki kalemler belgenin §1, §2 ve §3 ("Geliştiriciye notlar") bölümlerinden türetilmiştir. Öncelik atanmamıştır.

| # | Modül | İş kalemi | Referans |
| :-: | :-- | :-- | :-- |
| 1 | Doğalgaz — giriş formu | `kWh (doğal gaz)` birimini forma aç (şu an yalnız m³ ve Sm³). Baz: BUG-04'teki kWh ayrımı. | §1.3.1 |
| 2 | Doğalgaz — brüt/net UX | `kWh (doğal gaz)` seçilince `cvBasis` (NET/BRÜT) alanı zorunlu görünür. BRÜT'te otomatik düzeltme sun (GCV varsa `NCV_ref / GCV_fatura`, yoksa × 0,9) ve düzeltmeyi kullanıcıya göster. Ham `422` yalnız `cvBasis` boşken kalır. | §1.3.3 |
| 3 | Doğalgaz — motor yolu | kWh girişinde NCV adımı atlanır; kWh hacme geri çevrilmez. | §1.3.2 |
| 4 | Öz-üretim — alan modeli | `generationTopology` enum'u (A / B / C) baştan konur; bu turda yalnız A seçilebilir, B ve C disabled. | §1.4.2 |
| 5 | Öz-üretim — form | `selfGenerationSource` zorunlu; kaynağa göre doğru alanlar açılır. Boşsa Scope atanamaz → kayıt submit edilemez (fail-closed). | §1.4.3 |
| 6 | Öz-üretim — yakıtlı kaynak | `generationFuelType` + `generationFuelQuantity` mevcut **Sabit Yanma** modülünü besler (yeni hesap yolu yok). | §1.4.3 |
| 7 | Öz-üretim — Scope eşlemesi | Scope 2 = `gridFromKwh × EF_yıl`; öz-üretilen kWh Scope 2'ye girmez; Scope 2 asla negatif olamaz. | §1.4.1, §1.4.4 |
| 8 | Öz-üretim — enerji dengesi | `gridNet = tesisTüketimi − selfGeneratedKwh + exportedToGridKwh`; tutarsızlıkta **uyar, bloke etme**. | §1.4.5 |
| 9 | Öz-üretim — avoided | Kaçınılan emisyon raporda "bilgi amaçlı" gösterilebilir; Scope 1/2/3 toplamlarına eklenmez. | §1.4.4 |
| 10 | Öz-üretim — market-based | Sertifikalı (I-REC / YEK-G) öz-tüketilen yenilenebilir için sıfır faktörlü ayrı satır. | §1.4.6 |
| 11 | Kanıt | Öz-üretim kayıtlarında fatura (PDF) zorunlu (`K3`). | §1.4.3 |
| 12 | Test | GV-NG-kWh-A/B/C ve GV-SG-1/2/3 eklenir; GV-NG-kWh-C ↔ GV-4 çapraz doğrulaması çalıştırılır. | §2.2, §2.3 |

---

## 4. Kesinleşen Mimari ve Uyum Kararları (`K1, K2, K4, K5, S1–S3`)

- **`K1` (Ana Şirket ve Kurum Hiyerarşisi) → Seçenek A (pilot için hemen) + Seçenek C (pilot sonrası):**
  Bağımsız her müşteri ayrı bir `Organizasyon (Ana Şirket)` olur. Ekranda katmanlar **Ana Şirket → Bağlı Şirket → İşletme/Tesis** olarak adlandırılır. Aynı holding içinde bir kullanıcıya birden fazla Bağlı Şirket atanabilmesi hemen açılır.
- **`K2` (`super_admin` kendi kaydını onaylama) → Seçenek A (`D01` korunsun):**
  ISO 14064-3 dört göz kuralı gereği kimse kendi girdiği veriyi onaylayamaz. Testlerde iki ayrı hesap (veri giren + onaylayan) kullanılır.
- **`K3` (Kanıt doküman):** Tüm emisyon kategorilerinde `Submit` öncesi kanıt doküman (PDF) zorunlu (bkz. BUG-R2-02).
- **`K4` (Geçmişsiz ilk kayıtlarda anomali kontrolü) → `3a: Seçenek A + Typo Tavanı` / `3b: Seçenek 3`:**
  0 geçmiş dönem varken *"En az 3 dönem olmalı"* hatası yerine *"İlk dönem verisi — lütfen kanıt dokümanını ve birimi kontrol ediniz"* yazılır. Fazladan sıfır (typo) yakalamak için tekil kayıt tavanları:
  - Elektrik > 1.000.000 kWh
  - Doğalgaz > 250.000 Sm³
  - Araç yakıtı > 100.000 L
  - Şebeke kaçağı > 200.000 Stdm³
  - Soğutucu > 500 kg

  İncelemede ayrı "şüpheli" bayrağına gerek yoktur; mevcut **"Reddet ve Açıklama Yaz" (`rejected` → `draft`)** akışı kullanılır.
- **`K5` (Soğutucu gazların birleştirilmesi ve kanıt tanımı) → Seçenek A (hemen) → Seçenek B (sonraki adım):**
  Raporlarda gaz bazlı kırılım (CO₂, FM200, R-410A, R-32, SF₆) korunur. Faturası olmayan kapasite bazlı soğutucu kayıtlarında geçerli kanıtlar: *İmzalı Ekipman Envanter Listesi, Yetkili Servis Bakım Formu, Cihaz Etiketi (Nameplate) Fotoğrafı veya Dolum Faturası*.
- **`S1` (QA'daki eski kanıtsız kayıtlar):** Bekleyenler reddedilip kanıtla gönderilir; onaylılar `D04` (kilidi aç / geçersiz kıl / yeniden gir) prosedürüyle temizlenir.
- **`S2` (Faktör yayın tarihi):** İki ayrı tarih alanı gösterilir: `source_publication_date` (Resmi Yayım Tarihi) ve `package_sealed_date` (Paketin Mühürlenme Tarihi).
- **`S3` (UK MGO kategorisi):** `MGO` (gemi yakıtı) hem `TR` hem `UK`'de **Hareketli Yanma (`Mobile Combustion`)** altında yer alır.

---

## 5. Açık Konular ve Birleştirme Sırasında Tespit Edilen Tutarsızlıklar

### 5.1. v2.5'ten devreden açık kararlar
- **Case B ve C:** Alan modeli hazır, davranış kapalı. B için `exportedToGridKwh` zorunluluğu ve brüt-fatura uyarısı tanımlanacak.
- **Avoided raporlama yeri:** Rapor şablonunda ayrı "bilgi amaçlı" bölüm mü, dipnot mu?
- **YEK-G / I-REC market enstrümanı alanları:** Scope 2 Dual şemasına sertifika referansı + sertifikalı kWh alanı eklenecek.

### 5.2. İki belge arasında çözülmesi gerekenler
1. **`K4` typo tavanı ile GV-SG-2 çakışıyor.** GV-SG-2'nin girdisi 500.000 Sm³ doğalgaz; `K4` doğalgaz tekil kayıt tavanı 250.000 Sm³. Öz-üretim yakıtı Sabit Yanma modülünü beslediği için bu kayıt tavana takılıp `rejected → draft` akışına girebilir. Karar gerekli: tavan öz-üretim yakıtına uygulanacak mı, yoksa golden vektör testi tavanı bypass eden bir ortamda mı koşacak? Benzer şekilde GV-SG-1'in tüketim değeri (1.000.000 kWh) elektrik tavanının tam sınırında (tavan ">" olduğu için tetiklenmez, ancak kenarda).
2. **Alan adı tutarsızlığı:** v2.5 §2.3 tablosunda `selfGeneratedKwh`, §2.6'da (Scope 2 Dual şeması) `selfGenerationKwh` geçiyor. Tek ad üzerinde anlaşılmalı.
3. **Şema referansı doğrulanamadı:** v2.5 §2.6, Scope 2 Dual şemasında `greenElectricityShare` ve `selfGenerationKwh` alanlarının var olduğunu söylüyor; v2.4 compressed spec'te bu alanlar yer almıyor (yalnızca market-based formülü var). Tam şemadan teyit edilmeli.
4. **Onay durumu:** v2.4 CEO ve COO tarafından onaylı/mühürlü; v2.5 belgesinde onaylayan bilgisi yok. v2.5 bölümlerinin mühürlenmesi ayrıca netleştirilmeli.
5. **Yıl bilgisi:** v2.5 doğalgaz kWh vektörlerinde yıl belirtilmemiş (EF 56.154,3 ile GV-4'ün 2025 `TR` faktörüne denk geliyor); öz-üretim vektörleri açıkça TR-2025 (EF 0,434). 2026 için 0,434 yalnızca `D07` yedek yıl beyanıyla geçerli.

### 5.3. Tutarlılık kontrolü (bilgi amaçlı)
Birleştirme sırasında v2.5'in aritmetiği yeniden hesaplanıp doğrulandı:
- GV-NG-kWh-A: 0,0036 TJ × 56.154,3 = 202,16 kg ✔
- GV-NG-kWh-B: 900 kWh × 3,6×10⁻⁶ = 0,00324 TJ → 181,94 kg ✔
- GV-NG-kWh-C: 958,83 kWh × 3,6×10⁻⁶ ≈ 0,0034518 TJ → 193,83 kg (GV-4 ile örtüşüyor) ✔
- GV-SG-2: 17,259 TJ × 56.154,3 = 969.167 kg; 260,40 + 969,17 = 1.229,57 t ✔
- Brüt→net varsayılan çarpan 0,9, v2.4'teki 8.250 / 9.155 ≈ 0,901 oranıyla uyumlu ✔
