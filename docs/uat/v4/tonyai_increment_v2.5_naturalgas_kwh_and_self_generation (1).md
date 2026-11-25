# TONYAI — Artış Spec'i: Doğalgaz kWh Girişi + Öz-Üretim (Self-Generation) — Rev.3

**Belge ID:** `TONYAI-INC-2.5-01`
**Tarih:** 16 Kasım 2026
**İlişki:** Bu belge `TONYAI-MASTER-COMP-v2.4`'ün **üstüne eklenir**. v2.4'teki hesap zinciri,
golden vektörler ve UAT kararları **yeniden işlenmeyecek** — burada yalnızca iki yeni
yetenek tanımlanır ve gereken yerlerde v2.4'e referans verilir.
**Kapsam:** (1) Doğalgaz için kWh giriş birimi, (2) Öz-üretim / behind-the-meter
(bu turda yalnız **Case A — net sayaç**).
**Revizyon:** **Rev.3 — 24 Kasım 2026 · Go-Live paketi** (içerik Rev.2 ile aynı; §1 doğalgaz kWh girişi 1 Aralık'ta
canlı — BUG-11). Rev.2 (Go-Live Readiness Review): §1.3 brüt→net sabit oran 0,9011, fatura-kWh önseçimi,
GV-NG-kWh-B güncellendi. **§2 (öz-üretim) ERTELENDİ — go-live kapsamı dışı.**

---

## 0. Özet

| # | Yetenek | Motor durumu | Bu belgede yapılan |
| :-- | :-- | :-- | :-- |
| 1 | Doğalgaz kWh girişi | Zincir v2.4'te **zaten var** (`TJ = kWh × 3,6×10⁻⁶`, `cvBasis=NET`) | Giriş formunu açmak + brüt/net UX kuralı |
| 2 | Öz-üretim (Case A) | **⏸ ERTELENDİ** — go-live kapsamı dışı | Tasarım referans olarak korunur (§2); bu turda geliştirilmez |

---

## 1. Doğalgaz kWh Girişi

### 1.1 Mevcut durum (v2.4)
Motor doğalgaz kWh'ini zaten işleyebiliyor: v2.4 §1.2 doğalgaz kuralı #4 →
`cvBasis=NET` zorunlu, `TJ = kWh × 3,6×10⁻⁶`. Eksik olan tek şey **veri giriş
formu**: doğalgaz şu an yalnız `m³` ve `Sm³` kabul ediyor. `kWh (doğal gaz)` birimi
BUG-04'te elektrik kWh'inden zaten ayrılmıştı; şimdi doğalgaz tarafında da açılacak.

### 1.2 Yön kuralı (kritik — ters çevirme yok)
kWh zaten enerjidir. **kWh'i hacme (Sm³/m³) geri çevirme.** Motor birime göre farklı
giriş kapısı seçer:

| Giriş birimi | Zincir | Not |
| :-- | :-- | :-- |
| `Sm³` | `Sm³ × NCV × 4,184×10⁻⁹ → TJ` | Mevcut (v2.4) |
| `m³` | `m³ × VCF → Sm³`, sonra Sm³ yolu | Mevcut (v2.4) |
| `kWh (doğal gaz)` | **NCV adımını atla** → `TJ = kWh × 3,6×10⁻⁶` → EF | NCV'ye bağlanma, hacme dönme |

### 1.3 Brüt/Net CV — zorunlu UX kuralı
Faturadaki doğalgaz kWh'i neredeyse her zaman **brüt (GCV)**; motorun EF'i **net**.
v2.4 fail-closed kuralı brüt-kWh × net-EF kombinasyonunu `HTTP 422` ile zaten
reddediyor. Ama kullanıcıyı 422 duvarına toslatmak yerine formda çözülecek:

1. `kWh (doğal gaz)` seçilince `cvBasis` (**NET / BRÜT**) alanı **zorunlu** görünür.
2. **NET** seçilirse: doğrudan hesap.
3. **BRÜT** seçilirse: tek, sabit oranla düzeltilir — `kWh_net = kWh_brüt × 0,9011`
   (= 8.250 / 9.155; motorun kendi NCV/GCV referans çifti). Faturadaki GCV ile ayrı bir dal
   **yok**: referans NCV'yi gerçek fatura GCV'sine bölmek (8.250 / ~9.330 = 0,884) ~%2 eksik sayardı.
   Düzeltme kullanıcıya açıkça gösterilir; ham 422 yalnız `cvBasis` boş bırakılırsa
   kalır (sessiz varsayım yok).
4. **UX:** Türkiye'de doğalgaz faturasındaki kWh üst ısıl değerle (brüt) hesaplanır. Seçenekler
   sade dille gösterilir ve **"Faturadaki kWh (üst ısıl değer)" önseçilidir**; ikinci seçenek
   "Net kWh (alt ısıl değer)". Faturadaki kWh'i yanlışlıkla NET işaretlemek sonucu ~%11 şişirir —
   önseçim bu hatayı önler; temsilci gerekirse değiştirir.

### 1.4 Golden vektörler (±%0,5) — birleşik EF 56.154,3 kgCO₂e/TJ

| # | Girdi | Zincir | Beklenen | Kabul aralığı |
| :-- | :-- | :-- | :-- | :-- |
| GV-NG-kWh-A | 1.000 kWh (NET) | `× 3,6×10⁻⁶ = 0,0036 TJ` | **0,2022 tCO₂e** (202,16 kg) | 0,2011 – 0,2032 |
| GV-NG-kWh-B | 1.000 kWh (BRÜT) | `×0,9011 = 901,15 kWh net → 0,0032441 TJ` | **0,1822 tCO₂e** (182,17 kg) | 0,1813 – 0,1831 |
| GV-NG-kWh-C | 958,83 kWh (NET) | ≈ 100 Sm³ @ NCV 8.250 | **0,1938 tCO₂e** | 0,1928 – 0,1948 |

> GV-NG-kWh-C bilinçli olarak **GV-4 (100 Sm³) ile çapraz doğrulama** içindir: aynı
> enerji, farklı birim, aynı sonuç. Motor kWh ve Sm³ yollarında ±%0,5 içinde
> örtüşmeli — örtüşmezse birim dönüşümünde hata var demektir.

---

## 2. Öz-Üretim / Self-Generation — Case A (Behind-the-Meter, Net Sayaç)

> **⏸ ERTELENDİ (Rev.2):** Öz-üretim go-live kapsamı dışıdır (BUG v4 §4). Bu bölüm sonraki faz
> için referans tasarım olarak korunur; **bu turda geliştirilmez.** Go-live'da elektrik faturasındaki
> "GES Hatta Verilen Elektrik Üretimi" satırı Scope 2'ye girmez (INC-2.9 §4).

### 2.1 Temel prensip
Üç değişmez kural; motor bunlara göre kurulmalı:

1. **Scope 2 = yalnızca gridden NET çekilen kWh × yıllık EF.** Faturadaki brüt rakam
   değil, öz-tüketilen öz-üretim değil.
2. **Öz-üretimin karbonu kaynağına bağlıdır:** yenilenebilir (güneş/rüzgâr) → doğrudan
   emisyon **sıfır**; yakıtlı (doğalgaz kojen / dizel jeneratör) → emisyon **yakıttan**
   (Scope 1), ürettiği kWh'ten değil.
3. **Çift sayım yasağı:** yakıtlı öz-üretimin yakıtı Scope 1'de sayılır; ürettiği kWh
   Scope 2'ye **hiç girmez**.

### 2.2 Topoloji kapsamı
Bu iterasyon **yalnız Case A**: üretim yerinde tüketilir, fazlası şebekeye verilir,
açık şebekeden alınır; sayaç **net alışverişi** görür. Alan modeli B ve C'yi de
kaldıracak şekilde kurulur ama bu turda **kapatılır (not implemented)**:

- **Case B** (üretimin tamamı şebekeye basılıp geri çekilir — mahsuplaşma/satış): fatura
  **brüt** gösterebilir; `exportedToGridKwh` zorunlu hale gelir. → Sonraki tur.
- **Case C** (ada / off-grid): `gridNet = 0`, her şey Scope 1 ya da sıfır. → Sonraki tur.

> Alan modeli ileriye uyumlu olsun diye `generationTopology` enum'u (A | B | C) baştan
> konur; bu turda yalnız A seçilebilir, B/C disabled.

### 2.3 Veri alanları (Case A)

| Alan | Zorunlu? | İşlevi |
| :-- | :-- | :-- |
| `generationTopology` | zorunlu (bu turda sabit `A`) | İleriye uyumluluk |
| `selfGenerationSource` | **zorunlu** | Scope ve faktörü belirler (solar/wind → 0; natural_gas/diesel → Scope 1). **Kaynak bilinmeden Scope atanamaz.** |
| `selfGeneratedKwh` | zorunlu | Enerji dengesi + market-based iz |
| `gridFromKwh` (fatura net çekilen) | zorunlu | **Scope 2 location temeli** |
| `exportedToGridKwh` | opsiyonel (A'da genelde düşük) | Enerji dengesi; Scope'u azaltmaz |
| `generationFuelType` + `generationFuelQuantity` (Sm³ / L) | yakıtlı kaynakta **zorunlu** | **Scope 1** (Sabit Yanma modülüne gider) |
| Fatura (PDF) | zorunlu (K3) | Kanıt + denge doğrulaması |

### 2.4 Emisyon eşlemesi

| Üretim kaynağı | Scope 1 | Scope 2 (location) | Öz-üretilen kWh |
| :-- | :-- | :-- | :-- |
| Güneş / rüzgâr | 0 | `gridFromKwh × EF_yıl` | 0 (totale girmez) |
| Doğalgaz kojen | yakıttan (Sabit Yanma) | `gridFromKwh × EF_yıl` | Scope 2'ye **girmez** |
| Dizel jeneratör | yakıttan (litre dizel) | `gridFromKwh × EF_yıl` | Scope 2'ye **girmez** |

**Kaçınılan emisyon (avoided):** yenilenebilir öz-tüketim sayesinde kaçınılan miktar
(`öz-tüketilen × EF`) istenirse raporda **"bilgi amaçlı / avoided"** gösterilir ama
Scope 1/2/3 **toplamlarına eklenmez**. Scope 2 asla negatif olamaz.

### 2.5 Enerji dengesi (motor validation)
```
gridNet = tesisTüketimi − selfGeneratedKwh + exportedToGridKwh
```
Girilen `gridFromKwh` bu denge ile tutarsızsa motor **uyarır** (bloke etmez; v2.4
anomali mantığıyla aynı ruhta — `rejected → draft` akışı). "Veri eksiği yaşamadan"
hedefi burada karşılanır: form kaynağa göre doğru alanları açar, dengeyi kontrol eder.

### 2.6 Market-based not
Case A'da öz-tüketilen yenilenebilir, sertifikalıysa (I-REC / YEK-G) market-based
Scope 2'de **sıfır faktörlü ayrı satır** olarak kredilenebilir; location-based yine
fiziksel `gridFromKwh`'i yansıtır. İkisi v2.4 Scope 2 Dual şemasındaki
`greenElectricityShare` + `selfGenerationKwh` alanlarıyla taşınır. (B senaryosunda
location ve market belirgin şekilde ayrışır — o yüzden B sonraki tura bırakıldı.)

### 2.7 Golden vektörler (±%0,5) — TR-2025, EF 0,434

| # | Senaryo | Girdi | Beklenen | Not |
| :-- | :-- | :-- | :-- | :-- |
| GV-SG-1 | Saf solar (A) | Tüketim 1.000.000 kWh; solar öz-üretim 400.000; gridFrom 600.000 | **Scope 2 = 260,40 tCO₂e** (600.000 × 0,434); **Scope 1 = 0** | Öz-tüketilen 400.000 totale girmez |
| GV-SG-2 | Doğalgaz kojen (A) | gridFrom 600.000 kWh + üretim yakıtı 500.000 Sm³ doğalgaz (NCV 8.250) | **Scope 2 = 260,40 tCO₂e**; **Scope 1 = 969,17 tCO₂e** (yakıttan) | Üretilen kWh Scope 2'ye girmez; S1+S2 = 1.229,57 t |
| GV-SG-3 | Avoided (bilgi amaçlı) | Saf solar; öz-tüketilen 400.000 kWh | **Avoided = 173,60 tCO₂e** (400.000 × 0,434) | **Toplamlara EKLENMEZ**, yalnız raporda bilgi |

GV-SG-2 Scope 1 türetimi: `500.000 × 8.250 × 4,184×10⁻⁹ = 17,259 TJ × 56.154,3 =
969.167 kg = 969,17 tCO₂e` (Sabit Yanma — Doğalgaz zinciri, v2.4 §1.2).

### 2.8 Karar bekleyen / sonraki tur
- **Case B & C**: alan modeli hazır, davranış kapalı. B için `exportedToGridKwh`
  zorunluluğu ve brüt-fatura uyarısı tanımlanacak.
- **Avoided raporlama yeri**: rapor şablonunda ayrı "bilgi amaçlı" bölüm mü, dipnot mu?
- **YEK-G / I-REC** market enstrümanı alanları: v2.4 Scope 2 Dual şemasına eklenecek
  sertifika referansı + sertifikalı kWh alanı.

---

## 3. Geliştiriciye notlar (v2.4 çapraz referans)

- Doğalgaz kWh: motor zinciri mevcut (v2.4 §1.2 #4); iş **UI birimi + brüt/net UX +
  §1.1 fail-closed'ın 422 yerine düzeltme sunması**. BUG-04'teki kWh ayrımını baz al.
- *(Ertelendi — sonraki faz)* Öz-üretim yakıtı: yeni bir hesap yolu **değil** — mevcut **Sabit Yanma** modülüne
  `generationFuelQuantity` besler. Yeni olan sadece veri girişi + Scope eşlemesi +
  enerji dengesi.
- Fail-closed korunur: `selfGenerationSource` boşsa Scope atanamaz → kayıt submit
  edilemez.
- Hiçbir golden vektör v2.4'tekilerle çakışmaz; GV-NG-kWh-C bilerek GV-4'e bağlıdır.
