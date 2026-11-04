# Sayısal Kabul İçin Gerekenler — Yönetim Onayı, Kesin Faktör Paketi ve Metodolojik Düzeltmeler
**Tarih:** 4 Kasım 2026  
**Kimden:** Nebil Arda Gökceviz (CEO / `super_admin` & Owner) & İsmet Emrecan Kapusuz (COO / `consultant`)  
**Kime:** @Deniz (CTO) & Yazılım / AI Geliştirme Ekibi  
**Referans:** `D05`, `D06`, `D07–D09`, `D24`, `L6`, `LP4-02` ve `ENERYA ENERJİ A.Ş. V8-2.xlsx` (Resmi Envanter Referans Dosyası)  
**Durum:** **5 KALEMİN TAMAMI ONAYLANDI VE TESLİM EDİLDİ (BLOKAJ KALDIRILDI)**

---

## Yönetici Özeti: 30 Kasım / 20 Aralık Takvimi Beklenmeyecek
Yazılım tarafının talep ettiği **5 kalemin tamamı** (Pilot Holding Kaynak Listesi, Resmi Faktör Kaynakları ve Lisanslar, Bağımsız Gözden Geçiren Ataması, Tam Faktör Satırları/Birim Dönüşümleri ve İmzalı Altın Test Değerleri) halihazırda doğrulanmış kurumsal envanterimizde (`ENERYA ENERJİ A.Ş. V8-2.xlsx`) mevcuttur ve **bu dokümanla birlikte eksiksiz olarak teslim edilmiştir.**

Dolayısıyla:
1. Hesaplama motorunun açılması için **30 Kasım veya 20 Aralık 2026 tarihlerinin beklenmesine gerek yoktur**; bu dokümandaki mühürlü tablolar bugün itibarıyla `seed data` olarak sisteme yüklenmeli ve UAT (Kullanıcı Kabul Testi) 2. turu derhal açılmalıdır.
2. **"Yazılım tarafı hazır" tespitine şerh:** UAT 1. turda tespit ettiğimiz `BUG-01`..`BUG-10` bulgularının önemli bir kısmı sadece "faktör beklenmesi" değil, doğrudan arayüz/mimari hatalarıdır (ör. `kWh (elektrik / gaz)` birleşik birimi, `178,` yazarken anlık virgül validasyon hatası, `2074` yılına kadar çıkan yıl listesi, alt lokasyon modalında scroll olmaması ve `TR/UK` statik dropdown yerine Harita/Geolocation servisi gereksinimi). Faktör yüklemesiyle eşzamanlı olarak bu UI/mimari hataları da giderilmelidir.

---

## Özet Tablo — 5 Kalemin Güncel Durumu

| # | Kalem | Karar Ref. | Karar Veren / Onaylayan | Yeni Durum |
| :---: | :--- | :---: | :--- | :--- |
| **1** | Pilot holdingin kaynak listesi | `D05`, `D06` | Nebil Arda Gökceviz & İsmet Emrecan Kapusuz | **TAMAMLANDI (Aşağıda)** |
| **2** | Faktör kaynakları ve lisanslar | `L6`, `D07–D09` | Nebil Arda Gökceviz (Owner Onayı) | **ONAYLANDI (Aşağıda)** |
| **3** | Bağımsız gözden geçiren | `D24` | Nebil Arda Gökceviz (Owner Ataması) | **ATANDI (Aşağıda)** |
| **4** | Faktör satırları ve dönüşümler | `LP4-02` | Goldera / TonyAI Sürdürülebilirlik Ekibi | **TESLİM EDİLDİ (Aşağıda)** |
| **5** | Altın test değerleri (Golden Vectors) | `LP4-02` | Nebil Arda Gökceviz & İsmet Emrecan Kapusuz | **İMZALANDI (Aşağıda)** |

---

## 1. Pilot Holdingin Kaynak Listesi ve Raporlama Yılı (`D05`, `D06`)

**Pilot Holding:** Enerya Enerji A.Ş. ve bağlı 10 gaz dağıtım iştiraki (*Enerya Aksaray, Antalya, Aydın, Denizli, Ereğli, Erzincan, Kapadokya, Karaman, Konya Gaz Dağıtım A.Ş. ve Büyük Marmara Doğal Gaz ve Elektrik A.Ş.*).

* **Raporlama Yılı Düzeltmesi (`D06`):** Kurumsal karbon muhasebesinde (TSRS / ISO 14064-1) içinde bulunulan yılda bir önceki tam takvim yıllarının gerçekleşen faturaları raporlanır. Bu nedenle sistemde **2024 ve 2025 yılları ZORUNLU aktif envanter yıllarıdır** ("isteğe bağlı" değildir). **2026** ise cari dönem veri girişi için aktif olmalıdır. Veri giriş ekranındaki `2027–2074` yılları kaldırılmalıdır.
* **Kapsam Dışı Gösterim Kuralı:** İştirak bazında aşağıda yer almayan kaynaklar raporda `0` olarak değil, **"Kapsam Dışı (N/A)"** olarak görünmelidir.

| Kaynak / Kategori | Scope | Pilot Holdingde Durumu | Bildirilen Birim ve Metodolojik Kural |
| :--- | :---: | :---: | :--- |
| **Şebeke Elektriği (`Electricity`)** | Scope 2 | **Aktif (Tüm Tesisler)** | Ülke: `TR` (ve `UK`). Birim: **`kWh (elektrik)`** ve **`MWh (elektrik)`**. GES iç tüketimi ve Yeşil Elektrik (`I-REC` / `YEK-G`) alanları dahil. |
| **Doğalgaz — Sabit Yanma (`Natural Gas`)** | Scope 1 | **Aktif (Ofis & RMS-A Ön Isıtma)** | Birim: **`Sm³`** (Ana birim), **`m³`** (`volumeCorrectionFactor` ile) ve **`kWh (doğal gaz)`** (`cvBasis=NET` zorunlu). |
| **Diğer Sabit Yanma Yakıtları (`Stationary`)** | Scope 1 | **Aktif (Jeneratör / Kazan)** | Yakıtlar: **Dizel (`Litre`), Benzin (`Litre`), LPG (`kg`), Kömür (`kg`), LNG (`kg`), Fuel Oil (`kg`)**. |
| **Araç Filosu — Hareketli Yanma (`Mobile`)** | Scope 1 | **Aktif (Şirket & Bakım Araçları)** | Birim: **`Litre`**. Araç modu seçimi zorunludur: **`ON ROAD (Gasoline)`**, **`ON ROAD (Diesel)`**, **`ON ROAD (LPG)`**, **`OFF ROAD (Gasoline)`**, **`OFF ROAD (Diesel)`**. |
| **Şebeke Doğalgaz Kaçağı (`Fugitive Gas`)** | Scope 1 | **Aktif (Dağıtım Şebekesi)** | **Yazılım notunda eksik bırakılmış kritik kalemdir!** Birim: **`std m³` (`Stdm3`)**. Yalnızca $\text{CH}_4$ kaçağı üretir ($\text{CO}_2=0, \text{N}_2\text{O}=0$), `GWP = 29,8`. |
| **Soğutucu & Söndürme Gazları (`Refrigerants`)** | Scope 1 | **Aktif (Klima, FM200, Tüp, Trafo)** | **Metodoloji Düzeltmesi:** Yalnızca "yıl içinde eklenen kg" ile hesaplanmaz! `Kurulu Kapasite × Cihaz Varsayılan Kaçak Oranı (%) × GWP + Dolum Miktarı × GWP` formülüyle çalışır. |
| **Satın Alınan Isı / Buhar (`Heat / Steam`)** | Scope 2 | **Kapsam Dışı (`N/A`)** | Pilot holdingde satın alınan merkezi ısı/buhar yoktur; raporda **"Kapsam Dışı"** görünmelidir. |

---

## 2. Faktör Kaynakları, Lisanslar ve Metodolojik Kararlar (`L6`, `D07–D09`)

Owner (**Nebil Arda Gökceviz**) tarafından onaylanmış resmi kaynak ve lisans kayıtlarıdır; teknik ekip bu tabloyu doğrudan `publisher` ve `factor_release` tablolarına işleyebilir:

| Konu | Onaylanan Resmi Yayın & Sürüm | Kaynak URL / Atıf | Lisans & Durum |
| :--- | :--- | :--- | :--- |
| **Türkiye Yakıt Faktörleri (Scope 1)** | **IPCC 2006 Guidelines for National Greenhouse Gas Inventories**, Vol. 2 (Energy), Ch. 2 (Stationary - Table 2.2) & Ch. 3 (Mobile - Table 3.2.1 & 3.2.2) + Türkiye Ulusal Envanter / BOTAŞ NCV kabulleri | `https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol2.html` | Kamuya Açık Uluslararası Standart (IPCC Public Domain) — **ONAYLANDI** |
| **Türkiye Şebeke Elektriği (Scope 2)** | **T.C. Enerji ve Tabii Kaynaklar Bakanlığı (ETKB - EVCED)**, *Türkiye Elektrik Üretimi ve Elektrik Tüketim Noktası Emisyon Faktörleri Bilgi Formu* | `https://enerji.gov.tr/evced-cevre-ve-iklim-elektrik-uretim-tuketim-emisyon-faktorleri` | T.C. Resmi Kamu Yayını (Açık Kamu Verisi) — **ONAYLANDI** |
| **UK Faktörleri (Scope 1 & 2)** | **DESNZ (UK Dept for Energy Security and Net Zero)**, *UK Government GHG Conversion Factors for Company Reporting* (2024, 2025 ve 2026 sürümleri) | `https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting` | **Open Government Licence (OGL) v3.0** — **2024, 2025 ve 2026 ONAYLANDI** |
| **Gecikmeli Yıl Kuralı (`D07`)** | ETKB şebeke faktörleri 1–2 yıl gecikmeli yayınlanır. Sistemde **2024 raporlama yılı için `0,442 kgCO2e/kWh`**, **2025 ve 2026 raporlama yılları için `0,434 kgCO2e/kWh`** resmi atıfla tanımlanmıştır. | Faktör satırında `reporting_year` (`2025`/`2026`) ve `data_year` (`2023`/`2024` ETKB yayını) açıkça gösterilir; tanımsız yıllar (ör. `2023` ve öncesi) **FAIL-CLOSED** hata verir. | **ONAYLANDI** |
| **Sertifikalar (`D08`)** | Holdingde **I-REC**, **YEK-G** (TR) ve **REGO** (UK) desteği ile **GES İç Tüketim** alanı bulunmalıdır. | Sertifika/piyasa verisi girilmediğinde Market-Based sonucu kopyalanmaz; **"Piyasa bazlı sonuç bulunmamaktadır"** beyanı basılır. | **ONAYLANDI** |
| **GWP Seti (`D09`)** | **IPCC AR6 (Sixth Assessment Report, WGI Table 7.15 - 100-year GWP)** tek resmi settir. | $\text{CO}_2 = 1$, $\text{N}_2\text{O} = 273$, **$\text{CH}_4\text{ (Yanma / Fosil)} = 27,0$**, **$\text{CH}_4\text{ (Fugitive Kaçak)} = 29,8$**. | **ONAYLANDI** |

---

## 3. Bağımsız Karbon Muhasebesi Gözden Geçireni Ataması (`D24`)

Owner tarafından sistemdeki tüm faktör sürümlerini ve altın test vektörlerini mühürlemek üzere aşağıdaki atama yapılmıştır:

* **Baş Gözden Geçiren (Lead Reviewer & Sign-off):** **Nebil Arda Gökceviz** — *Head of Sustainability (Goldera Consulting) / CEO & Managing Partner (TonyAI)*
* **İkinci Gözden Geçiren (Co-Reviewer):** **İsmet Emrecan Kapusuz** — *COO & Managing Partner (TonyAI)*
* **İnceleme ve Mühür Tarihi:** `2026-11-04`
* **Sürüm Kodu:** `TONYAI-EF-TR-UK-2026.11-AR6-SEALED`

---

## 4. Kesin Faktör Satırları ve Birim Dönüşüm Kuralları (`LP4-02`)

### 4.1. KRİTİK METODOLOJİK DÜZELTME: Doğalgaz `Sm³` Hesaplama Zinciri
Yazılım notunun 4. bölümünde yer alan *"Türkiye doğalgaz faturaları Sm³'ü üst (brüt) ısıl değerle enerjiye çevirir; bu yüzden Sm³ → kWh dönüşümünün kaynağı da gerekir"* ifadesi **metodolojik olarak yanlıştır ve düzeltilmelidir:**
1. IPCC 2006 doğalgaz emisyon faktörleri (`56.100 kg CO2/TJ`, `1 kg CH4/TJ`, `0,1 kg N2O/TJ`) **Net Kalorifik Değer (NCV / Alt Isıl Değer)** bazlıdır.
2. Faturalardaki `kWh` değeri ise **Üst Isıl Değer (GCV / Brüt)** bazlıdır. `Sm³`'ü fatura üst ısıl değeriyle brüt `kWh`'e çevirip Net emisyon faktörüyle çarpmak **%10 civarında hatalı (fazla) emisyon hesaplanmasına yol açar** (CV-Basis Guardrail ihlali).
3. **Doğru Hesaplama Zinciri (`Sm³ → TJ Net CV`):**
   * **Varsayılan (Standart) Mod:** Kullanıcı `Sm³` girdiğinde ekranda varsayılan Net Kalorifik Değer **`8.250 kcal/Sm³`** sabit/dolu gelir (kullanıcı elle revize edebilir).
   * **Formül:** $\text{Enerji (TJ)} = \text{Miktar (Sm}^3) \times \text{NCV (kcal/Sm}^3) \times 4,184 \times 10^{-9}$
   * *(Not: Eğer faturadaki fiili Üst Isıl Değer $\text{GCV}_{\text{fatura}}$ üzerinden BOTAŞ referans üst ısıl değeri $9.155\text{ kcal/Sm}^3$ düzeltmesi uygulanıyorsa efektif NCV $= 8.250 \times (9.155 / \text{GCV}_{\text{fatura}})$ olur; örneğin Enerya Aksaray Ortaköy Ofis kaydında $\text{GCV}_{\text{fatura}} = 9.349,174\text{ kcal/Sm}^3$ için efektif $\text{NCV} = 8.078,67\text{ kcal/Sm}^3$ olup tam olarak altın vektör olan `0,002500 TJ` ve `0,1404 tCO2e` değerini verir).*

### 4.2. Birim Dönüşüm Tablosu (`unit_conversions`)

| Kaynak Birim | Hedef Birim | Çarpan / Formül | Kalorifik Baz | Referans Koşulları & Dayanak |
| :--- | :--- | :--- | :---: | :--- |
| `kcal` | `kJ` | `× 4,184` | `NET` | Uluslararası Buhar Tablosu (IT Calorie) / IPCC 2006 |
| `kcal` | `TJ` | `× 4,184 × 10^-9` | `NET` | $1\text{ TJ} = 10^9\text{ kJ}$ |
| `kWh (doğal gaz)` | `TJ` | `× 3,6 × 10^-6` | `NET` (Zorunlu) | $1\text{ kWh} = 3,6\text{ MJ} = 3,6 \times 10^{-6}\text{ TJ}$ (`cvBasis=GROSS` ise **RED / 422**) |
| `MWh (elektrik)` | `kWh (elektrik)` | `× 1.000` | `N/A` | Standart SI birim dönüşümü |
| `m³ (doğal gaz)` | `Sm³ (doğal gaz)` | `× volumeCorrectionFactor` | `NET` | Sayaç hacminden standart hacme düzeltme (15 °C, 1013,25 mbar) |
| `Stdm3 (şebeke kaçağı)` | `Sm³ (0°C bazlı)` | `× (273 / 288)` (`0,9479167`) | `N/A` | Enerya V8-2 (`1.4 Atmosfere Kaçan Gazlar` Sütun I: 15°C=288K → 0°C=273K düzeltmesi) |

### 4.3. Sabit Yanma Emisyon Faktörleri (`TR`, `2024–2026`, `Scope 1`, `cvBasis=NET`)
*Kaynak: IPCC 2006 Vol. 2 Ch. 2 Table 2.2 & Enerya V8-2 `EF Tablolar` Tablo 1 | GWP: AR6 ($\text{CO}_2=1, \text{CH}_4=27,0, \text{N}_2\text{O}=273$)*

| Yakıt Türü | Giriş Birimi | Yoğunluk | Alt Isıl Değer (NCV) | $\text{EF CO}_2$ (kg/TJ) | $\text{EF CH}_4$ (kg/TJ) | $\text{EF N}_2\text{O}$ (kg/TJ) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Doğalgaz (`Natural Gas`)** | `Sm³` | `0,67 kg/Sm³` | **`8.250 kcal/Sm³`** | `56.100` | `1,0` | `0,1` |
| **Dizel (`Diesel - Stationary`)** | `Litre` | `0,83 kg/L` | `10.200 kcal/kg` | `74.100` | `3,0` | `0,6` |
| **Benzin (`Gasoline - Stationary`)**| `Litre` | `0,735 kg/L` | `10.400 kcal/kg` | `69.300` | `3,0` | `0,6` |
| **LPG (`LPG - Stationary`)** | `kg` | `0,56 kg/L` | `10.900 kcal/kg` | `63.100` | `1,0` | `0,1` |
| **Kömür (`Coal`)** | `kg` | `1,0` | `6.100 kcal/kg` | `98.300` | `10,0` | `1,5` |
| **LNG (`LNG`)** | `kg` | `1,0` | `8.250 kcal/kg` | `64.200` | `3,0` | `0,6` |
| **Fuel Oil (`Fuel Oil`)** | `kg` | `1,0` | `9.600 kcal/kg` | `77.400` | `3,0` | `0,6` |

### 4.4. Hareketli Yanma (Araç Filosu) Emisyon Faktörleri (`TR`, `2024–2026`, `Scope 1`, `cvBasis=NET`)
*Kaynak: IPCC 2006 Vol. 2 Ch. 3 Table 3.2.1 & 3.2.2 & Enerya V8-2 `EF Tablolar` Tablo 4 | GWP: AR6 ($\text{CO}_2=1, \text{CH}_4=27,0, \text{N}_2\text{O}=273$)*

| Araç / Yakıt Modu (`Vehicle Type`) | Birim | Yoğunluk (kg/L) | NCV (kcal/kg) | $\text{EF CO}_2$ (kg/TJ) | $\text{EF CH}_4$ (kg/TJ) | $\text{EF N}_2\text{O}$ (kg/TJ) | Birleşik Eşdeğer ($\text{kgCO}_2\text{e/L}$) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`ON ROAD (Gasoline)`** | `Litre` | `0,735` | `10.400` | `69.300` | `25,0` | `8,0` | **`2,307825`** (`≈ 2,308 - 2,309`) |
| **`ON ROAD (Diesel)`** | `Litre` | `0,830` | `10.200` | `74.100` | `3,9` | `3,9` | **`2,668403`** (`≈ 2,668`) |
| **`ON ROAD (LPG)`** | `Litre` | `0,560` | `10.900` | `63.100` | `62,0` | `0,2` | **`1,656513`** |
| **`OFF ROAD (Gasoline)`** | `Litre` | `0,735` | `10.400` | `69.300` | `50,0` | `2,0` | **`2,277722`** |
| **`OFF ROAD (Diesel)`** | `Litre` | `0,830` | `10.200` | `74.100` | `4,15` | `28,6` | **`2,907271`** |

### 4.5. Şebeke Elektriği Emisyon Faktörleri (`TR`, `Scope 2 - Location Based`)
*Kaynak: T.C. Enerji ve Tabii Kaynaklar Bakanlığı (ETKB - EVCED)*

| Coğrafya | Raporlama Yılı | Değer | Birim | Metodoloji & Kaynak Atıfı |
| :---: | :---: | :---: | :---: | :--- |
| **`TR`** | **`2024`** | **`0,442`** | `kgCO2e/kWh` | Location-Based Ulusal Şebeke Faktörü (ETKB EVCED Türkiye Elektrik Tüketim Noktası EF) |
| **`TR`** | **`2025`** | **`0,434`** | `kgCO2e/kWh` | Location-Based Ulusal Şebeke Faktörü (ETKB EVCED Bilgi Formu & Enerya V8-2 `2.1 Elektrik Tüketimi`) |
| **`TR`** | **`2026`** | **`0,434`** | `kgCO2e/kWh` | Location-Based Ulusal Şebeke Faktörü (`D07` onaylı gecikmeli yıl kuralı: yeni ETKB bülteni yayınlanana kadar `2025` resmi değeri kullanılır, faktör satırında `data_year=2024/2025` olarak açıkça beyan edilir) |

### 4.6. Sızıntı Ekipmanları Kaçak Oranları ve Seçili Gaz GWP Değerleri (`Scope 1`)
*Kaynak: IPCC 2006 Vol. 3 Ch. 7 & Enerya V8-2 `EF Tablolar` Tablo 2 ve Tablo 3 (IPCC AR6)*

* **Cihaz Varsayılan Yıllık Kaçak Oranları:**
  * `Yangın Söndürme Sistemi`: **`%2,0`** (`0,02`)
  * `Yangın Söndürme Tüpü`: **`%4,0`** (`0,04`)
  * `Transformatör Kesici Gazı (SF6)`: **`%0,01`** (`0,0001`)
  * `Klima (Split / Ofis)`: **`%1,0`** (`0,01`) — *(Genel ticari/split normu olarak `%10,0` opsiyonu da desteklenmeli)*
  * `Su Sebili`: **`%0,1`** (`0,001`)
  * `Buzdolabı`: **`%0,1`** (`0,001`)
  * `Chiller`: **`%2,0`** (`0,02`) — *(Endüstriyel chiller normu `%8,0` opsiyonu dahil)*
  * `Araç Kliması (Mobile AC)`: **`%15,0`** (`0,15`)
  * `Taşınabilir Klima`: **`%10,0`** (`0,10`)
* **Temel Gaz AR6 GWP Değerleri:** `CO2 = 1`, `FM200 (HFC-227ea) = 3.600`, `R-410A = 2.256`, `R-134a = 1.530`, `R-32 = 771`, `R-404A = 4.728`, `HCFC-22 (R22) = 1.960`, `SF6 = 25.200`.

---

## 5. İmzalı Altın Test Değerleri (Golden Test Vectors — `LP4-02`)

Gözden geçiren (**Nebil Arda Gökceviz**) tarafından elle hesaplanıp Enerya V8-2 resmi envanteriyle çapraz doğrulanmış ve imzalanmış altın test şablonudur. Otomatik birim/entegrasyon testlerine doğrudan gömülebilir:

```csv
kategori,cografya,yil,girdi_miktari,girdi_birimi,donusum_adimi,faktor_degeri,faktor_birimi,kaynak_atfi,beklenen_kgCO2e,yuvarlama,hesaplayan
Electricity,TR,2025,4180.56,kWh,Dogrudan kWh (1 kWh = 0.0000036 TJ),0.434,kgCO2e/kWh,ETKB EVCED TR Ulusal Sebeke EF (Enerya V8-2 Sayfa 2.1 Satir 2),1814.36,1.814 tCO2e (±%0.5),Nebil Arda Gokceviz
Electricity,TR,2024,4180.56,kWh,Dogrudan kWh (1 kWh = 0.0000036 TJ),0.442,kgCO2e/kWh,ETKB EVCED TR Ulusal Sebeke EF 2024,1847.81,1.848 tCO2e (±%0.5),Nebil Arda Gokceviz
Electricity,TR,2026,4180.56,kWh,Dogrudan kWh (D07 onayli gecikmeli yil EF=2025),0.434,kgCO2e/kWh,ETKB EVCED TR Ulusal Sebeke EF (D07 Yedek Yil Beyanli),1814.36,1.814 tCO2e (±%0.5),Nebil Arda Gokceviz
Natural Gas,TR,2025,73.953103,Sm3,73.953103 Sm3 * (9155/9349.174) * 8250 kcal/Sm3 * 4.184e-9 = 0.0024997 TJ (veya 8078.67 efektif NCV),CO2:56100|CH4:1|N2O:0.1 (AR6 GWP 1|27|273 -> 56154.3 kgCO2e/TJ),kg/TJ,IPCC 2006 Vol.2 Ch.2 Table 2.2 (Enerya V8-2 Sayfa 1.1 Satir 2),140.37,0.1404 tCO2e (±%0.5),Nebil Arda Gokceviz
Natural Gas,TR,2025,100.00,Sm3,100 Sm3 * 8250 kcal/Sm3 (Varsayilan Sabit NCV) * 4.184e-9 = 0.0034518 TJ,CO2:56100|CH4:1|N2O:0.1 (AR6 GWP 1|27|273 -> 56154.3 kgCO2e/TJ),kg/TJ,IPCC 2006 Vol.2 Ch.2 Table 2.2 Fallback NCV=8250,193.83,0.1938 tCO2e (±%0.5),Nebil Arda Gokceviz
Mobile Combustion (On-Road Gasoline),TR,2025,15973.75,Litre,15973.75 L * 0.735 kg/L * 10400 kcal/kg * 4.184e-9 = 0.5108804 TJ,CO2:69300|CH4:25|N2O:8 (AR6 GWP 1|27|273 -> 72159.0 kgCO2e/TJ),kg/TJ,IPCC 2006 Vol.2 Ch.3 Table 3.2.1 & 3.2.2 (Enerya V8-2 Sayfa 1.2 Satir 2),36864.62,36.8646 tCO2e (±%0.5),Nebil Arda Gokceviz
Mobile Combustion (On-Road Diesel),TR,2025,3784.51,Litre,3784.51 L * 0.830 kg/L * 10200 kcal/kg * 4.184e-9 = 0.1340536 TJ,CO2:74100|CH4:3.9|N2O:3.9 (AR6 GWP 1|27|273 -> 75270.0 kgCO2e/TJ),kg/TJ,IPCC 2006 Vol.2 Ch.3 Table 3.2.1 & 3.2.2 (Enerya V8-2 Sayfa 1.2 Satir 3),10090.24,10.0902 tCO2e (±%0.5),Nebil Arda Gokceviz
Fugitive Natural Gas Leakage,TR,2025,84783.36,Stdm3,84783.36 * (273/288) = 80367.56 Sm3; * 0.7409 kg/Sm3 * 0.92 CH4 = 54780.779 kg CH4,29.8 (AR6 Fugitive CH4 GWP),kgCO2e/kgCH4,IPCC AR6 WGI Table 7.15 & Enerya V8-2 Sayfa 1.4 Atmosfere Kacan Gazlar Satir 2,1632467.22,1632.47 tCO2e (±%0.5),Nebil Arda Gokceviz
Fugitive Refrigerant / Fire Suppression (FM200),TR,2025,40.00,kg,40 kg (40000 g) * 0.02 (Yangin Sondurme Sistemi %2 kacak) = 0.80 kg FM200,3600 (AR6 HFC-227ea / FM200 GWP),kgCO2e/kg,IPCC 2006 Vol.3 Ch.7 & Enerya V8-2 Sayfa 1.4 Sizinti Satir 4,2880.00,2.8800 tCO2e (±%0.5),Nebil Arda Gokceviz