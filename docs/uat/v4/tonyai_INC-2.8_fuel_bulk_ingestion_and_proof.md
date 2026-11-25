# TONYAI — INC-2.8: Akaryakıt (Fuel) Bulk Ingestion & Kanıt Eşleştirme — Rev.3

**Belge ID:** `TONYAI-INC-2.8` · **Rev.3 — 24 Kasım 2026 · Go-Live paketi** (Rev.2 + §3.1 "Sayın" / alıcı ifadesi,
§7 paylaşılan fatura kuralı, §8 manuel giriş notu; önceki sürümlerin yerine geçer)
**İlişki:** `INC-2.6` (owningEntity, merkezi raportör, onay zinciri) + `v2.4` (mobile_combustion motoru) +
`INC-2.9` §5 (kanıt asistanı).
**Kapsam:** Go-live'da bulk yüklemesi açık olan **tek** kategori: akaryakıt. Tasarım Ahlatcı'nın gerçek 2025
dosyalarıyla test edildi (8 Shell dışa aktarımı, Petrol Ofisi `SatisListesi` 44.902 satır, tanker alımları,
4 OZK + 23 Duman faturası).
**Go-live (1 Aralık):** üç adaptör, hesap eşleme, paket onayı ve kanıt asistanı birlikte canlıya çıkar (tam kapsam
kararı, 24 Kasım). "Bitti" tanımı: handoff index §4 kabul testleri.

---

## 0. İlke — tool altyapıyı sağlar, beyanı temsilci yapar

TonyAI verinin kendisini tutmaz; şirket temsilcilerinin kendi verilerini girip tCO₂e'lerini hesaplaması için
alanları ve fonksiyonları sağlar. **Operasyonel beyanlar** (yakıt tipi, kullanım: on-road / off-road / sabit)
**temsilciye aittir**; tool bunları zorunlu, açık seçimler olarak sorar ve sessiz varsayım yapmaz.

---

## 1. Üç veri akışı

| Akış | Kaynak dosya | Biçim | Not |
| :-- | :-- | :-- | :-- |
| **Shell yakıt kartı** | şirket başına bir dışa aktarım (sayfa `items`) | işlem satırı | Satırda fatura no **yok**; fatura = Duman Petrol, hesap × yarım-ay |
| **Petrol Ofisi yakıt kartı** | `SatisListesi` (tek dosya, tüm hesaplar) | işlem satırı; `Satış ID` benzersiz | `Fatura Numarası` (OZK…) her satırda |
| **Tanker / şirket deposuna toplu teslimat** | `PETROL OFİSİ TANKER ALIMLARI` | teslimat başına bir satır | **Ayrı akış** — kart faturalarıyla ortak fatura no yok. Dosyada yakıt tipi, kullanım ve **tarih kolonu yok**. Son satır **TOPLAM**. |

> 2025 ölçeği (bilgi): kart işlemleri ≈51.300 satır; tanker 51 teslimat, 1.219.635 L — grubun mobil yakıtının
> ~%41'i. Tanker yolu olmadan Scope 1 mobil ~%42 eksik kalır.

---

## 2. Yakıt tipi normalizasyonu — kural-bazlı (sabit liste DEĞİL)

Aynı yakıt farklı adlarla geliyor (Petrol Ofisi'nde tek yılda 6 ürün adı). Kural — büyük/küçük harf ve Türkçe
karakter duyarsız:

| Ham metin içeriyorsa | Kanonik | v2.4 faktörü (bilgi) |
| :-- | :-- | :-- |
| MOTORİN / DIESEL / DİZEL | **motorin** | on-road ≈ 2,6662 · off-road ≈ 2,9053 kgCO₂e/L |
| KURŞUNSUZ / BENZİN | **benzin** | on-road ≈ 2,3078 kgCO₂e/L |
| (ileride) LPG, MGO | ilgili kanonik | v2.4 varyantı |
| hiçbiri | — | **eşleşmeyenler tepsisi** (fail-loud; sessiz atma yok) |

Gerçek örnekler → **benzin:** "Kurşunsuz 95 V/Max", "Kurşunsuz 95 Oktan", "Kurşunsuz 95 Ultimate",
"Kurşunsuz 95 - Shell Vp", "KURŞUNSUZ BENZİN SHELL - 95 VP", "Kurşunsuz 95 Benzin".
**motorin:** "Motorin Med", "Motorin Ultimate", "Motorin Diesel", "Motorin - Shell Vp Diesel",
"MOTORIN-SHELL VP DIESEL". Test: 51.335 satırın **0**'ı eşleşmeden kaldı (yalnız 2 adı tanıyan sabit liste
114.527 L'yi düşürürdü).

> Bir fatura/giriş hem motorin hem benzin içerebilir → her yakıt **ayrı kayıt**, ayrı faktör.

---

## 3. owningEntity — yakıt kartı hesabı

### 3.1 Yakıt kartı sistemi nasıl çalışır (dosyalardan doğrulandı)
1. Her şirketin sağlayıcıda bir **filo/müşteri hesabı** vardır — Petrol Ofisi `Filo` + `Filo Kod Adı`
   (örn. `120.01.1640` = Enerya Konya), Shell `Müşteri Adı` + `Müşteri Kodu`.
2. Her araç o hesaba bağlı bir tanıma cihazı taşır — Akıllı Halka / UTTS, TTB cihazı, anahtarlık veya kart.
   **Cihaz başına tek araç** (Petrol Ofisi'nde 1.139 kartın %100'ü tek plakada).
3. Her dolum hesaba otomatik kaydedilir: hesap, plaka, istasyon, ürün, litre, tarih-saat.
4. Sağlayıcı 15 günde bir fatura keser — çoğunlukla hesap başına bir fatura; bazı faturalar birden çok hesabın
   satırını taşır (§6, §7). Faturadaki **"Sayın" bir hitaptır, veri değildir:** alıcı, hitaptan sonra gelen
   **ticari unvan** ve birkaç satır altındaki **VKN**'dir (örn. "AHLATÇI METAL RAFİNERİ A.Ş." + VKN); alıcı şahıs
   olsaydı ad (+ varsa ikinci ad) + soyad ve TCKN yazardı. Alıcı bilgisi **yalnız gösterilir**; atama hesap
   kodundan yapılır (§3.2).

→ Hesap bilgisi her satırda zaten var (Petrol Ofisi ve Shell'de 0 eksik); **ek veri gerekmez.**

### 3.2 Kural
- **owningEntity = yakıt kartı hesabının eşlendiği şirket** — INC-2.9 §3.3: öner → bir kez onayla → otomatik uygula.
- Eşleme **hesap koduna** göre yapılır (Petrol Ofisi `Filo Kod Adı`, Shell `Müşteri Kodu`); ad yalnız gösterim
  içindir — aynı kod yıl içinde iki adla görünebiliyor (örn. `120.01.1675` Otomotiv hesabı iki farklı adla).
- 2025 verisinde ≈36 hesap var (28 Petrol Ofisi + 8 Shell): kurulumda bir kez eşlenir, sonraki her yükleme
  otomatik atanır. Yeni/bilinmeyen hesap → eşleşmeyenler tepsisi.
- **Tanker:** owningEntity = alıcı şirket (`AÇIKLAMA`), aynı eşleme mantığıyla.
- **Filo listesi go-live'da gerekmez.**

### 3.3 Bilinen sınırlama (metodoloji notunda açıkça yazılır)
Bazı hesaplar **havuz** olarak kullanılıyor: örn. Otomotiv'in Petrol Ofisi hesabı 2025'te ~27 şirketin aracını
yakıtlamış, yalnız %17'si Otomotiv/İnşaat'ın kendi aracı. Hesap-bazlı atama bu yakıtı hesap sahibine yazar →
**şirket-bazlı dağılım kayar, grup toplamı değişmez** (associate araçlarının grup içi hesaplardan aldığı yakıt
≈3.400 L ≈ 9 t, %0,1). Bir bağlı şirket tek başına rapor gerektirirse, filo listesiyle araç-bazlı yeniden
dağıtım sonraki fazda eklenir.

---

## 4. Sınır kuralı — associate hesapları

Ham veride kapsam dışı associate'lere ait hesaplar var (Dünya Katılım Bankası, Marmara Çorlu, Marmara Yalova,
Büyük Marmara — 2025'te ≈272.500 L). Hesap bir associate'e eşlenirse satırlar otomatik
**"excluded — öz kaynak"** olarak kaydedilir: Scope 1 toplamına girmez, denetim izinde görünür.

---

## 5. Adaptörler (üç deterministik adaptör)

| Alan | Shell `items` | Petrol Ofisi `SatisListesi` | Tanker |
| :-- | :-- | :-- | :-- |
| activityValue (L) | `Miktar (LT)` | `Miktar` | `MİKTAR` |
| yakıt tipi | `Ürün` → §2 | `Tip` → §2 | **temsilci seçer** (dosyada yok) |
| kullanım | temsilci beyanı, **on-road önseçili** | temsilci beyanı, **on-road önseçili** | temsilci seçer, **önseçim yok** |
| raporlama dönemi | `İşlem Tarihi` | `Tarih` — **`Dönem` tarih DEĞİL** (yarım-ay kodu: `-01` = 1–15, `-02` = 16–31) | dosyada tarih yok → **yüklemede dönem seçilir** (fatura PDF'i eklenirse fatura tarihi) |
| owningEntity | `Müşteri Kodu` → eşleme | `Filo Kod Adı` → eşleme | `AÇIKLAMA` → eşleme |
| fatura bağı | hesap × yarım-ay (Duman) | `Fatura Numarası` (OZK) | `EVRAK NO` |
| dedupe anahtarı | `Kart No + İşlem Tarihi + Miktar + İstasyon Kodu` | `Satış ID` | `EVRAK NO` |
| reportedByEntity | yükleyen (örn. Ahlatcı Tedarik) | yükleyen | yükleyen |

**Kullanım beyanı → modül:** on-road / off-road → mobile_combustion (v2.4 araç modu); **sabit / jeneratör** →
stationary_combustion (v2.4 "Sabit Yanma — Diğer Yakıtlar"). Hesap v2.4 zinciriyle
(L × ρ × NCV → TJ → gaz-bazlı → tCO₂e).

**Ortak güvenlikler**
- Katı başlık eşleşmesi + **fail-loud**: beklenen kolonlar yoksa dosya net mesajla reddedilir.
- **Yalnız gerekli kolonlar okunur** (tanker dosyasında para kolonlarının başlıkları verilerle kayık).
- **Anahtar alanı boş satırlar reddedilir** — tanker dosyasının sonundaki TOPLAM satırı (`EVRAK NO` boş,
  1.219.635 L) aksi halde tüm tanker yakıtını **iki kez** saydırır.
- Sayılar hücre tipinden okunur; metin hücrede Türkçe biçim (`1.168,00` → 1168,00) çözülür.
- Associate hesapları → excluded (§4).

---

## 6. İnceleme birimi = paket (batch)

Bulk yükleme satırları tek tek onaya düşürmez (2025'te ≈51.300 satır). Satırlar **paketlere** toplanır:
**owningEntity × fatura.**
- Petrol Ofisi: `Fatura Numarası` başına; bir fatura birden çok hesabı kapsıyorsa (2025'te 600 faturanın 54'ü)
  hesap başına bölünür.
- Shell: hesap × yarım-ay (= bir Duman faturası).
- Tanker: teslimat faturası (`EVRAK NO`) başına.

Onayla / iade et / geri çek **paket düzeyinde** (INC-2.6 §1.2); satırlar paketin içinde görüntülenir.
Paket tüketen şirketin super_admin'ine gider (yoksa masterkey — INC-2.6 §1.1). Manuel tek giriş = tek kayıtlık
paket; bugünkü akış değişmez. 2025 ölçeğinde ≈51.300 satır yerine ≈900 paket.

---

## 7. Kanıt eşleştirme (INC-2.9 §5 kanıt asistanı — go-live'da açık)

- Asistan **paket toplamını** faturanın ilgili yakıt satırıyla **yan yana gösterir**; karar vermez, bloke etmez.
- **Gerçek veriyle test:** 40 fatura satırının **36'sı litresine kadar birebir**; kalan 4'ü iki "dönem kayması" çifti.
- **Dönem kayması kuralı:** fark varsa komşu faturada eşit-ve-ters fark aranır; bulunursa
  🟢 "dönem kayması — komşu faturayla dengeleniyor". (Örnek: Mart'ın ilk yarısında alınan 31,86 L bir sonraki
  yarım-ay faturasına yazılmış.) Envanter etkilenmez — dönem işlem tarihinden gelir.
- **Paylaşılan fatura:** bir fatura numarası birden çok pakette geçiyorsa (2025, kapsam içi: 502 faturanın 54'ü →
  563 paketin 115'i, litrelerin ~%27'si) asistan karşılaştırmayı **fatura düzeyinde** yapar: o fatura numaralı tüm
  satırların toplamı (kapsam dışı / associate satırları dahil) ↔ faturanın yakıt satırı. Paket kartında "Bu fatura
  N hesap arasında bölünmüş" notu ve kardeş paketler gösterilir. Paket-bazlı karşılaştırma bu 115 paketin
  **hepsini** 🟠 gösterirdi (küçük payın medyanı %2,8 > ±%1). Örnek: `OZK2025000011923` = AHL Gold 15 satır /
  669,38 L + Otomotiv 1 satır / 19,63 L. Faturanın alıcısı bu şirketlerden yalnız biridir → alıcı **kontrol olarak
  kullanılmaz** (§3.1). Altın setteki 4 OZK faturası tek hesaplı; paylaşılan bir fatura PDF'i gelince sete eklenir
  ve fatura toplamının tüm paketleri kapsadığı teyit edilir.
- **Çok-faturalı PDF:** bir PDF birden çok fatura içerebilir (`duman_petrol.pdf` = 23 ayrı fatura). Yüklemede
  `Fatura No` ile bölünür; kanıt fatura düzeyinde (dosya + sayfa) saklanır.
- **Satır-bazlı okuma:** ürün ve litre **aynı tablo satırından** okunur. Komşu satırdan ürün adı ödünç almak,
  test sırasında doğru faturalarda sahte ~%15 fark üretti. Okuyucu her sürümden önce **altın fatura setini**
  (4 OZK + 23 Duman, Readiness Review değerleri) geçmelidir.
- Fatura eklenmemişse asistan ⚪ "kanıt okunamadı / eklenmedi" der; onay engellenmez (kanıt zorunluluğu K3
  ayrıca geçerli).

---

## 8. Manuel veri giriş ekranı

- Yakıt tipi dropdown: motorin / benzin / (LPG, MGO — v2.4 varyantları).
- **Kullanım zorunlu:** on-road / off-road / sabit-jeneratör.
- Bir fatura birden çok yakıt içerebilir → aynı dönem için çok satır (her satır ayrı kayıt).
- `invoice_no` ve `supplier` opsiyonel (BUG-16).
- Ekranda tek satır not: *"Grup yakıt kartlarıyla (Shell / Petrol Ofisi) alınıp merkezi olarak yüklenen yakıtı
  burada tekrar girmeyin — o yakıt kartın hesap sahibine yazılır."* Gerekçe: havuz kartlar (§3.3) — bir şirketin
  aracı başka bir şirketin kartıyla yakıt alabiliyor; aynı yakıtı araç sahibi şirket de girerse çift sayılır.

---

## 9. Kurulum — müşteri masterkey'i yapar, tool destekler

1. Yakıt dosyalarında görünen **tüm şirketleri** ilk bulk yüklemeden önce ağaçta oluştur ve controlled/associate
   işaretle; aksi halde satırlar eşleşmeyenler tepsisinde bekler.
2. Yakıt kartı hesaplarını (kod bazında) şirketlere bir kez eşle; merkezi raportör (örn. Tedarik) yetkisini ver.
3. Her şirketin envanter sınırında ilgili kategorileri (mobile combustion vb.) işaretle → veri gelmeyen şirket
   matriste kırmızı "missing" görünür (örn. araçları olup yakıt verisi gelmeyen bir şirket).

---

## 10. Sonraki faz (go-live dışı)

- Filo listesiyle araç-bazlı yeniden dağıtım (havuz hesaplar için; opsiyonel).
- Depo dağıtım kaydıyla tanker yakıtının şirketlere dağıtımı; yıl sonu depo stok değişimi (opsiyonel).
- Diğer kategoriler (elektrik, su, doğalgaz) → INC-2.9.
