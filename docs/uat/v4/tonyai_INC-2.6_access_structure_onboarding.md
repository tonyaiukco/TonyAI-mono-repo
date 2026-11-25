# TONYAI — INC-2.6: Access, Group Structure & Onboarding — Rev.3

**Belge ID:** `TONYAI-INC-2.6` · **Rev.3 — 24 Kasım 2026 · Go-Live paketi** (önceki sürümlerin yerine geçer)
**İlişki:** `TONYAI-MASTER-COMP-v2.4` + `TONYAI-INC-2.5` üstüne eklenir; `TONYAI-ROADMAP-01` Phase 1–2'yi karşılar.
Mühürlü hesap zinciri ve golden vektörler **yeniden işlenmez**.
**Kapsam:** Rol modeli, onay zinciri ve düzenle / geri çek / yeniden gönder akışı, grup-yapısı şeması (recursive
tree), masterkey-sahipli konsolidasyon, owningEntity / merkezi raportör, çift-sayım kuralları, erişim matrisi,
onboarding.
**Referans müşteri:** Ahlatcı Holding (TSRS).
**Rev.2 değişiklikleri:** roll-up kuralı (parent şirketler kendi kayıtlarını tutabilir), onay yönlendirme yedeği,
geri çekme durum kuralı + atomik durum değişimi, merkezi raportör rol tanımı, associate'lerde veri girişi kapalı,
ağaç bütünlük kuralları, `equity_share` go-live'da kapalı, coğrafya yalnız yüklü faktör setleri, eski §8
(AI görüşü) kaldırıldı → INC-2.8 / INC-2.9.
**Rev.3:** bu belgedeki her şey **1 Aralık'ta canlı** (tam kapsam kararı, 24 Kasım); §9'a dashboard AI okuyucu ve
dashboard renk mantığı açık maddesi eklendi (ROADMAP O7).

---

## 1. Rol Modeli (final)

`consultant` emekli; `executive_viewer` → `auditor` olarak yeniden konumlandı.

| Rol | Kapsam | Yapabildikleri |
| :-- | :-- | :-- |
| **masterkey** | Tüm grup | Onboarding setup; ana/üst şirketleri oluşturur; konsolidasyonu belirler; üst envanter sınırlarını çizer; super-admin atar; merkezi raportör yetkisi verir; hesap eşlemelerini onaylar; veri girer + onaylar (kendi dahil, loglanır); her şeyi görür. |
| **super_admin** | Atanmış şirket(ler), **çoklu** | Kendi kapsamında alt (child) şirket + lokasyon oluşturur; kendi şirketinin sınırını ayarlar; standard user atar (kategori tikleyerek); veri girer; standard user verisini ve kendi şirketine gelen merkezi raportör paketlerini onaylar. |
| **standard_user** | **Tek ana entity**, tikli kategori sınırı; + opsiyonel **merkezi raportör yetkisi** (masterkey verir: belirli kategoriler, birden çok owning şirket) | Yalnız veri girer. |
| **auditor** | Read-only | Tüm hesap izini (factorId, methodology, gwpBasis, gaz-bazlı kırılım), audit log'u, sınır dışı bırakma notunu ve metodoloji ekini okur; düzenleme yok. Üçüncü taraf güvence denetçisi için. |

### 1.1 Onay zinciri (four-eyes)
- `standard_user` girer → **super_admin** onaylar.
- `super_admin` girer → **masterkey** onaylar.
- `masterkey` girer → **kendisi onaylar** → `actionType: self_approve` audit kaydı yazılır ve **auditor görünümünde
  açıkça görünür** (godmode istisnası şeffaf loglanır).
- Merkezi raportör (örn. Tedarik kullanıcısı) bir şirket için girer → **o şirketin super_admin'i** onaylar;
  şirketin super_admin'i yoksa → **masterkey**.
- **Onay birimi:** tek kayıt ya da bulk **paketi** (INC-2.8 §6).
- **Onay yükü notu:** her super_admin girişi masterkey onayı bekler. Müşteri buna göre planlamalı — veriyi ağırlıkla
  standard user'lar girmeli, super_admin'ler onaylamalı.

### 1.2 Düzenle → Geri Çek → Yeniden Gönder (inceleme kuyruğu akışı)
- **Submit sonrası read-only:** kayıt/paket submit edilince giren için read-only olur; inceleme kuyruğundaki sürüm
  altından değişmez → "stale-onay" bug'ı yapısal olarak engellenir.
- **Geri çek (recall):** yalnız durum **`submitted`** iken (henüz kimse açmadı). İnceleyen açtığında durum
  **`under_review`** olur → geri çekme kapanır.
- **Atomik durum değişimi (versiyon kontrolü):** aynı kayıt/paket için geri çekme ve onay aynı anda başarılı olamaz;
  ikinci işlem "kayıt değişti, lütfen yenileyin" mesajı alır.
- **İade (return):** inceleyen kaydı/paketi gerekçeyle draft'a döndürür.
- **Yeniden gönderimde:** anomali kontrolü + kanıt asistanı (INC-2.9 §5) **yeni değere göre tekrar çalışır**.
- **İnceleme kuyruğu minimal kalır:** onaylayan yalnız **güncel** kaydı görür + status yanında ayrı renkli
  **"Yeniden Gönderildi / Revize"** rozeti (`anomaly_flagged` gibi opsiyonel ek rozet). Diff ekranda gösterilmez.
- **Denetim izi tam hikâyeyi tutar:** alan-bazlı before→after diff **yalnız burada**; her olay ayrı renk/işaretle:
  `geri çekildi` / `iade edildi` / `düzenlendi` / `yeniden gönderildi`.
- Bulk paketlerinde aynı kurallar **paket düzeyinde** geçerlidir.

---

## 2. Grup-Yapısı Şeması (recursive tree)

Ağaç **özyinelemeli**: her düğüm bir üst düğüme `partOf` ile bağlanır; derinlik sabit değil (Ahlatcı'nın en derin
dalı: Holding > Ahlatcı Doğalgaz AŞ > Enerya Doğalgaz > Enerya Yalovagaz > lokasyonlar). Basit dallarda
Holding → Sektör → Şirket → Lokasyon gibi görünür.

```markdown
# Group Structure: Ahlatcı Holding
primaryGhgApproach: operational_control        # masterkey-set, bir kez

## Node (recursive)
  nodeId: co_enerya_yalovagaz
  type: holding | sub_holding | sector_group | company | child_company | location
  partOf: grp_enerya_dogalgaz                  # null yalnız holding kökünde
  name: Enerya Yalovagaz
  # company / child_company alanları:
  sector: dogalgaz
  naceCode: 35.22                              # opsiyonel
  geographyCode: TR                            # yalnız faktör seti yüklü coğrafyalar; konum servisi sonraki sürüm
  control: controlled | associate              # masterkey tikler
  sharePercent: 90.00                          # OPSİYONEL + inert; hiçbir kurala/hesaba girmez; boş bırakılabilir
  reportingBoundary: [scope_1, scope_2]        # + kategori listesi (envanter sınırı)
  createdByRole: masterkey | super_admin
  # location alanları:
  locationType: warehouse | office | factory | plant | refinery |
                retail_shop | mall | building | apartment | rms_station
```

### 2.1 Kurallar
- **Kayıt sahibi olabilen düğümler:** `holding`, `sub_holding`, `company`, `child_company`, `location`
  (tüzel kişilik veya tesis). **`sector_group` yalnız etikettir** → kayıt tutamaz.
- **control:** `controlled` → Scope 1/2'ye %100; `associate` → kapsam dışı, ağaçta "öz kaynak — Scope 1/2 dışı"
  etiketiyle görünür (örn. Dünya Katılım Bankası). **Associate'lere kullanıcı atanamaz ve veri girilemez**
  ("kapsam dışı — veri girişi kapalı"); bulk yüklemede associate'e eşlenen satırlar otomatik "excluded" olur (INC-2.8 §4).
- **sharePercent** opsiyonel ve inert; Scope 3 Cat 15 geldiğinde associate'ler için çarpan olur.
- **JV / graph durumları go-live kapsamı dışı** — tek sahip varsayılır.
- **Lokasyon** tek şirkete aittir.
- **Coğrafya:** yalnız faktör seti yüklü coğrafyalar seçilebilir (go-live: TR; UK yalnız DESNZ seti yüklüyse) —
  aksi halde kullanıcı fail-closed `HTTP 422` duvarına çarpar.

### 2.2 Ağaç bütünlüğü
- **Döngü yasak:** bir düğüm kendi alt düğümünün altına taşınamaz.
- Alt düğümü veya kaydı olan düğüm **silinemez** (önce taşı/arşivle).
- Kaydı olan düğümün **üst düğümü değiştirilemez** (go-live). İleride açılırsa değişiklik denetim izine loglanır ve
  roll-up geçmişi korunur.

---

## 3. Konsolidasyon (tamamen masterkey-sahipli)

Masterkey'in eforu **şirket başına iki tık**; altındaki hiçbir kullanıcı dokunmaz.

1. **Grup yaklaşımı — bir kez**, dropdown: **operational_control** (varsayılan) / financial_control.
   **`equity_share` go-live'da kapalı ("yakında")** — `sharePercent` opsiyonel olduğu için sonuç tanımsız kalırdı.
2. **Şirket başına** `control` tik: **controlled** veya **associate**.

Tool gerisini otomatik yapar:
- `controlled` → emisyon **%100** grup toplamına (hisse oranı çarpan değil).
- `associate` → Scope 1/2 **dışında**, kayıtlı; "boundary exclusions" denetim notu üretilir.
- Şirket başına görüntülenen GHG bazı **türetilir**, serbestçe seçilmez.

> `financial_control`, controlled/associate tikiyle aynı %100 / %0 davranışını verir; güvenle açık kalabilir.

---

## 4. owningEntity & Merkezi Raportör (Ahlatcı Tedarik modeli)

Veriyi giren ile emisyonun sahibi farklı olabilir; faaliyet kaydı iki referans taşır:

```markdown
## Activity Record (v2.4 kaydına ek alanlar)
  owningEntityId: co_enerya_konya        # emisyonun sayıldığı şirket — roll-up'ı sürükler
  reportedByEntityId: co_ahlatci_tedarik # veriyi giren entity — yalnız iz sürme
  createdBy: user_tedarik_01             # (mevcut)
  # Normal durum: owningEntityId == reportedByEntityId == kullanıcının entity'si
  # Merkezi raportör: reportedByEntityId = Tedarik, owningEntityId = emisyon sahibi şirket
```

Sağlayıcı bulk dosyalarında owningEntity, **yakıt kartı hesabının (hesap koduyla) eşlendiği şirkettir** —
INC-2.8 §3.

### 4.1 Merkezi raportör yetkisi (yeni rol DEĞİL — izin şekli)
```markdown
## Central Reporter Grant (masterkey verir)
  user: user_tedarik_01
  categories: [mobile_combustion, stationary_combustion]   # yakıt
  owningEntities: [co_enerya_konya, co_enerya_antalya, ...]
```

### 4.2 Çift-sayım güvencesi
- Bir `(owningEntity, category, period)` üçlüsü **tek bir tarafça** girilir: ya şirketin kendi standard_user'ı **ya da**
  merkezi raportör — ikisi birden değil. Merkezi raportöre atanan kategoriler o şirketlerin standard user'ına açılmaz.
- Onay: merkezi raportör girer → **owning şirketin super_admin'i** (yoksa masterkey) onaylar.

---

## 5. Çift-Sayım Önleme (konsolide)

1. **Tek kayıt, tek owningEntity** — zorunlu, tekil. Çift sayımı önleyen asıl kural budur.
2. **roll-up(düğüm) = düğümün kendi kayıtları + Σ alt düğümlerin roll-up'ı.** Parent/holding kendi operasyonunu
   (örn. kendi araç yakıtı) tutabilir; her kayıt tek sahipli olduğu için çift sayım oluşmaz.
   *(Eski "yalnız leaf" kuralı kaldırıldı: kendi faaliyeti olan Ahlatcı Holding ve Enerya Enerji gibi parent'ların
   kayıtlarını dışarıda bırakıyordu.)*
3. **Tek-giriş kuralı:** her `(owningEntity, category, period)` tek tarafça girilir (standard user XOR merkezi raportör).
4. **Grup-içi örtüşme etiketi** `intraGroupCounterpartyEntityId` (Scope 3 geldiğinde; bkz. INC-2.7).

---

## 6. Erişim & Yetki Matrisi (final)

| Aksiyon | masterkey | super_admin | standard | auditor |
| :-- | :---: | :---: | :---: | :---: |
| Ana/üst şirket oluştur | ✅ | ❌ | ❌ | ❌ |
| Alt (child) şirket oluştur | ✅ | ✅ (kendi kapsamı) | ❌ | ❌ |
| Lokasyon oluştur | ✅ | ✅ (kendi kapsamı) | ❌ | ❌ |
| Konsolidasyon belirle | ✅ | ❌ | ❌ | ❌ |
| Envanter sınırı çiz | ✅ (üst) | ✅ (kendi şirketi) | ❌ | ❌ |
| super_admin ata | ✅ | ❌ | ❌ | ❌ |
| standard_user ata | ❌ | ✅ (associate'e değil) | ❌ | ❌ |
| Merkezi raportör yetkisi ver | ✅ | ❌ | ❌ | ❌ |
| Hesap eşlemesini onayla (yakıt kartı → şirket) | ✅ | ✅ (yalnız kendi şirketine) | ❌ | ❌ |
| Veri gir | ✅ | ✅ | ✅ (+ merkezi raportör yetkisiyle) | ❌ |
| Onayla | ✅ (super_admin girişleri + kendi + yedek) | ✅ (standard + merkezi raportör paketleri) | ❌ | ❌ |
| Hesap izi / audit oku | ✅ | ✅ | limited | ✅ (tam) |

---

## 7. Onboarding Akışları

### 7.1 Masterkey onboarding (üst genealoji) — progresif sihirbaz
Tek ekranda tek adım; bitene kadar tam tool açılmaz. Şirket girişi **manuel** (otomatik içe aktarma sonraki faz).

1. **Holding kimliği** — ticari ad (kök düğüm).
2. **Konsolidasyon yaklaşımı** — operational_control / financial_control.
3. **Sektör grupları** — Doğal gaz, Bankacılık, Madencilik, Perakende, Rafineri, Finans, Gıda, Otomotiv, İnşaat, Yenilenebilir…
4. **Ana şirketler** — her biri: ad, sektör, NACE (ops.), geography (yüklü setlerden), `control` tik, reportingBoundary;
   sharePercent opsiyonel (atlanabilir). **İpucu:** yakıt kartı/fatura dosyalarında görünen tüm şirketleri ilk bulk
   yüklemeden önce oluşturun.
5. **Üst envanter sınırları** — şirket başına; işaretlenen kategoriye veri gelmezse matriste kırmızı görünür.
6. **Super-admin atama** — şirketlere (çoklu-entity).
7. **(Ops.) Merkezi raportör yetkisi + yakıt kartı hesap eşlemesi** — INC-2.8 §3, §9.
8. **Bitir → grup dashboard (şirket ağacı).**

### 7.2 Super-admin onboarding (alt yapı — daha hafif)
Setup sihirbazı yok; atanmış, kapsamlanmış tool'a düşer.
1. Kapsamlı dashboard'a iner.
2. Kendi kapsamında **lokasyon + alt (child) şirket** ekler.
3. **Standard user atar** (scope + emisyon kategorilerini tikler).
4. Veri girer + onaylar.

### 7.3 Standard user
Login → yalnız atanmış entity + kategoriler (ve varsa merkezi raportör kapsamı) → veri girişi. Kurulum yok.

---

## 8. Bulk Veri & Kanıt Okuma

Bu konular **INC-2.8** (akaryakıt — go-live: üç adaptör, paket onayı, yakıt kartı hesabı ataması) ve **INC-2.9**
(genel çerçeve, kanıt okuma kuralları, kanıt asistanı) belgelerinde tanımlıdır. Bu belgenin Rev.1 §8 içeriği
(sabit TonyAI şablonu, "AI görüşü — uyuşuyor / uyuşmuyor") **geçersizdir**; yerini INC-2.9 §5'teki
göster-ve-bırak kanıt asistanı aldı.

---

## 9. Açık / Sonraki

- `INC-2.7` — Scope 3 framework (sıralama kararı O4 açık; framework-first önerilir) — go-live sonrası.
- Tasarım paleti: parkta (Emre tekrar açana kadar).
- Konum servisleri: `geographyCode` manuel → harita/otomatik (fast-follow).
- GRI 2 / GRI 400 modülü (Phase 6): aynı ağacı paylaşır, hesap yapmaz.
- Şirket yapısını toplu içe aktarma: sonraki faz (go-live'da manuel).
- Araç-bazlı yakıt dağıtımı (filo listesi): sonraki faz, opsiyonel.
- Masterkey self-approval: kabul edildi; `self_approve` logu + auditor görünürlüğü ile şeffaf.
- **Dashboard AI okuyucu + daha izlenebilir, kolay gezilen dashboard** (ROADMAP O7): mevcut yeşil renk göstergesi
  istendiği gibi çalışmıyor. Emre detaylandıracak; 1 Aralık kapsamına eklenmedi — §7.1'deki şirket ağacı dashboard'u
  go-live'da bugünkü tanımıyla çıkar.

> Canlı belge: kararlar kapandıkça güncellenir.
