# TONYAI — INC-2.9: Bulk Ingestion, Kanıt Okuma & İnceleme Kuyruğu Kanıt Asistanı — Rev.3

**Belge ID:** `TONYAI-INC-2.9` · **Rev.3 — 24 Kasım 2026 · Go-Live paketi** (Rev.2 + §4.2 alıcı ifadesi, §5 paylaşılan
fatura ve alıcı kuralı, kanıt asistanı go-live'da açık; önceki sürümlerin yerine geçer)
**İlişki:** `INC-2.8` (akaryakıt — go-live) desenini **tüm kategorilere** genelleştirir; `INC-2.6` owningEntity /
merkezi raportör / onay zinciri üstüne oturur. Gerçek dosyalarla temellendirildi: `Ahlatcı Holding
Sürdürülebilirlik Veri Talep Formu`, `Kanıt Doküman Listesi`, elektrik / su / akaryakıt faturaları.
**Kapsam:** (1) bulk veri yükleme çerçevesi, (2) kanıt doküman okuma, (3) inceleme kuyruğu kanıt asistanı.
**Go-live (1 Aralık):** yalnız akaryakıt (INC-2.8) — kanıt asistanı dahil, açık. Diğer kategoriler fast-follow;
kuralları burada hazır.

---

## 1. "Veri Talep Formu" tool'un blueprint'idir

Ahlatcı'nın Excel **Veri Talep Formu** tool'un veri modelini hazır veriyor; her sayfa bir kategori + alanları.
Tool bunları ayna gibi alır (yeniden icat yok):

- **Yapı:** 01 Şirket Genel Bilgileri, 02 Organizasyonel Sınırlar (şirket + lokasyon + kontrol yaklaşımı)
- **Kapsam 1:** 05 Sabit Yanma (doğalgaz / jeneratör), 06 Hareketli Yanma, 07 Yangın Söndürme
  (**cihaz × gaz tipi ayrı alan, kapasite ve dolum gram**), 08 Soğutucu
- **Kapsam 2:** 09 Elektrik, Kapsam 2.2 Dolaylı Enerji (ısı/buhar)
- **Çevre/diğer:** 10 Su, 11 Atıklar
- **Kapsam 3:** 3.10 İşlenen, **3.11 Satılan Ürün Kullanımı (Cat 11)**, 3.12 Yaşam Sonu, 3.13 Kiralanan, 3.14 Franchise
- **GRI sosyal/ekonomik:** 12 Çalışan Demografisi, 13 İSG, 14 Çalışan Gelişimi, 15 Ekonomik, 16 Tedarik Zinciri

> Formun tamamlanma durumu (**Tamamlandı / Hazırlanıyor / Başlanmadı**) tool'un `completionStatus` enum'una
> (complete / incomplete / missing / **not_applicable**) birebir oturur.

---

## 2. Kanıt Doküman Konfigürasyonu (Kanıt Doküman Listesi'nden)

| Kategori | Kabul edilen kanıt |
| :-- | :-- |
| Sabit Yanma (doğalgaz/LNG/CNG/dizel) | Tüketim takip Excel'leri, faturalar, sayaç görselleri |
| Araç Yakıtları (benzin/dizel/LPG) | Araç yakıt tüketim faturaları |
| Yangın Söndürücüler | Ekipman takip Excel'leri, sistem çizimleri, görseller |
| Soğutucu Cihazlar | Cihaz görselleri, satın alma faturaları |
| Elektrik | Takip Excel'leri, faturalar, sayaç görselleri |
| Su | Takip Excel'leri, faturalar, sayaç görselleri |
| Atık | Atık çıkış formları, beyanlar, faturalar |
| Çalışan Demografisi / İSG / Gelişim | SGK bildirimleri, ERP kayıtları, İSG beyanları, eğitim/sertifika formları |

---

## 3. Bulk Veri Yükleme

### 3.1 Kanallar
- **Go-live:** sağlayıcı dışa aktarımları için deterministik adaptörler — akaryakıt: Shell, Petrol Ofisi, tanker
  (INC-2.8 §5).
- **Fast-follow:** Veri Talep Formu sayfalarından şablon içe aktarma (diğer kategoriler); fatura takip Excel'leri
  için adaptörler.
- **Sonraki faz:** serbest/bilinmeyen format semantik okuma.

### 3.2 Ortak eşleme ve paket
Her satır bir owningEntity'e bağlanır (INC-2.6); merkezi raportör satırlarında `owningEntityId ≠ reportedByEntityId`.
Zorunlu: `owningEntityId`, `categoryKey`, `activityValue`, `unit`, `period`, `evidenceRef`; opsiyonel: `invoiceNo`,
`supplier`. Satırlar **paketlere** toplanır (owningEntity × fatura veya kaynak dönemi); inceleme, onay, iade ve
geri çekme paket düzeyinde yapılır (INC-2.6 §1.2, INC-2.8 §6). `associate` owningEntity → excluded.

### 3.3 Atama — öner → bir kez onayla → otomatik uygula
Eşleme anahtarı = kaynaktaki **hesap / şirket kodu** (akaryakıt: yakıt kartı hesabı — INC-2.8 §3); ad yalnız
gösterim içindir. Kod ilk kez görüldüğünde tool bir şirket **önerir**, yetkili kişi (masterkey ya da hedef şirketin
super_admin'i) **tek tıkla onaylar**; eşleme kaydedilir ve sonraki yüklemelerde **otomatik** uygulanır.
Bilinmeyen → **eşleşmeyenler tepsisi**; asla tahmin edilmez.

### 3.4 Parser güvenlikleri
- **Katı başlık eşleşmesi + fail-loud:** beklenen kolonlar yoksa dosya net mesajla reddedilir.
- **Yalnız gerekli kolonlar okunur** — bazı dosyalarda başlıklar verilerle kayık (örn. tanker para kolonları).
- **Anahtar alanı boş satırlar reddedilir** (toplam / ara toplam satırları; örn. tanker TOPLAM satırı).
- Sayılar hücre tipinden okunur; metin hücrede **Türkçe biçim** (`1.168,00` → 1168,00) çözülür.
- **Tarih gibi görünen kodlar tarih sayılmaz** (örn. Petrol Ofisi `Dönem` = yarım-ay kodu); raporlama dönemi
  işlem tarihinden alınır.
- **Dedupe anahtarı adaptör başına** tanımlanır (INC-2.8 §5) → tekrar yükleme çift sayım üretmez.
- **Operasyonel beyanlar** (yakıt tipi, kullanım) temsilciden zorunlu seçim olarak alınır; sessiz varsayım yok.

---

## 4. Kanıt Doküman Okuma — çıkarım kuralları

### 4.1 Genel kurallar
- Değer **tek bir tablo satırından** okunur: açıklama/ürün ve miktar **aynı satırda**; komşu satırdan ad ödünç
  alınmaz (test sırasında doğru faturalarda sahte ~%15 fark üretti).
- Toplam tutar değil, **tüketim satırı** okunur.
- **Çok-faturalı PDF** `Fatura No` ile bölünür; kanıt fatura düzeyinde (dosya + sayfa) saklanır.
- Okuyucu her sürümden önce **altın fatura setini** geçer (akaryakıt: 4 OZK + 23 Duman; diğer kategoriler örnek
  geldikçe eklenir).

### 4.2 Doküman tipine göre

| Doküman | Okunacak değer | Birim | Ek alanlar | Dikkat |
| :-- | :-- | :-- | :-- | :-- |
| Elektrik faturası | **"Aktif enerji"** satırının `Tüketim(kWh)` değeri = şebekeden çekilen (import) | kWh | Abone No, Sayaç No, Fatura No, Dönem | Reaktif (Endüktif/Kapasitif) ve dağıtım/iletim bedeli satırları sayılmaz. **"Tüketiciler için Dağıtım Bedeli" de kWh'tir ve GES ihracatı düşülmüş nettir** (örn. 149.045,40 − 2.949,98 = 146.095,42) — kullanılmaz. **"GES Hatta Verilen Elektrik Üretimi"** satırı Scope 2'ye girmez ve tüketimden düşülmez (öz-üretim ertelendi, INC-2.5 §2). Endeks değil, `Tüketim` kolonu okunur. |
| Su faturası | "Şebeke sayacı su tüketimi" `Tüketim(m³)` | m³ | Abone No, Sayaç No, Fatura No, Dönem | "Toplam Tüketim" kolonu birimi **"ton"** yazıyor — değer `Tüketim(m³)` kolonundan okunur. Atık su / OSB katkı / katı atık satırları ayrı. |
| Akaryakıt faturası (OZK / DAU) | Her yakıt satırının `Miktar (lt)` değeri | litre | Fatura No, dönem, alıcı ("Sayın" hitabından sonraki unvan + VKN; yalnız gösterim) | Bir fatura birden çok yakıt satırı içerebilir (örn. "Kurşunsuz 95", "Motorin Med", "Kurşunsuz 95 Benzin") → yakıt başına toplam; yakıt adı INC-2.8 §2 kuralıyla. |
| Doğalgaz faturası | (örnek bekleniyor) Tüketim | Sm³ / m³ / kWh | Sayaç, dönem | Faturadaki kWh üst ısıl değerle (brüt) — INC-2.5 §1.3. |

---

## 5. İnceleme Kuyruğu — Kanıt Asistanı (karar DEĞİL; göster-ve-bırak)

**Tasarım ilkesi:** bu bir **asistandır**, kapı/hakem değil. Asla "uyuştu / uyuşmadı" kararı vermez ve onayı
**asla bloke etmez.** Kırılgan birebir eşitlik kapısı **yoktur.**

- Okuyucu faturadan ilgili değeri çıkarır; onaylayana **paket toplamıyla yan yana** gösterir:
  `Fatura: 7.502,66 L motorin (DAU…244, 01–15.02) | Paket: 7.502,66 L`. İnsan karar verir — asistan otorite değil, **hız.**
- **Üç yumuşak durum (hepsi non-blocking):** 🟢 tutarlı görünüyor · 🟠 olası fark (> tolerans — bir bakın) ·
  ⚪ güvenle okunamadı / kanıt eklenmedi ("lütfen manuel kontrol edin").
- **Dönem kayması kuralı:** fark varsa komşu faturada eşit-ve-ters fark aranır; bulunursa 🟢
  "dönem kayması — komşu faturayla dengeleniyor".
- **Paylaşılan fatura:** aynı fatura numarası birden çok pakette geçiyorsa karşılaştırma **fatura düzeyinde**
  yapılır — o fatura numaralı tüm satırların toplamı ↔ fatura — ve kartta not edilir (INC-2.8 §7).
- **Alıcı bilgisi** ("Sayın" hitabından sonraki unvan + VKN) yalnız gösterilir; eşleşme kontrolü olarak
  kullanılmaz. İleride kontrol eklenirse ad metniyle değil **VKN / TCKN** ile yapılır — aynı şirket üç kaynakta üç
  farklı yazılıyor ("AHLATÇI METAL RAFİNERİ" / "AHLATÇI METAL RAFİNERİ A.Ş" / "AHLATÇI METAL RAFİNERİ A.Ş.").
- **Tolerans:** ±%1 (varsayılan; yumuşak vurgu, hard-fail değil).
- **Onay asla beklemez:** asistan yavaş/çalışmıyorsa onaylayan kendi gözüyle onaylar; kuyruk durmaz.
- **Go-live'da açık.** Ayar (feature flag) yalnız **acil durum emniyetidir:** canlıda beklenmedik davranırsa
  kapatılır; onay akışı etkilenmez (onaylayan faturayı gözle kontrol eder).

> **Gerçek veri kanıtı (akaryakıt, 2025):** 40 fatura satırının 36'sı litresine kadar birebir; kalan 4'ü iki dönem
> kayması çifti — sağlayıcının işlemi bir sonraki yarım-ay faturasına yazması. Birebir eşitlik kapısı bunları
> yanlış alarm olarak işaretlerdi; asistan bunları doğru biçimde açıklar.

---

## 6. Go-Live Kapsamı (1 Aralık)

- **Go-live (1 Aralık): YALNIZ akaryakıt** — üç adaptör + paket onayı + yakıt kartı hesabı ataması + kanıt asistanı
  (açık; ayar yalnız acil durum emniyeti).
- **Fast-follow:** elektrik + su (kurallar §4'te hazır), doğalgaz, Veri Talep Formu şablon içe aktarma,
  sayaç görseli OCR, serbest format semantik okuma.

---

## 7. Açık / Gerekli
- Doğalgaz ve diğer kategori (atık vb.) fatura örnekleri → §4.2 tablosu genişler.
- Paylaşılan fatura PDF örneği (örn. `OZK2025000011923`) → altın sete eklenir (INC-2.8 §7).
- Tolerans: ±%1 varsayılan; değiştirilmek istenirse tek ayar.
- Kategori şablon alanları → Veri Talep Formu sayfalarından birebir türetilecek (fast-follow).
