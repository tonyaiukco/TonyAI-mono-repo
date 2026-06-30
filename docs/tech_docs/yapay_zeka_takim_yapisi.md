# TonyAI - Yapay Zeka (AI) Takım Yapısı ve Çalışma Modeli
*(Product Owner ve Product Manager'lar için Teknik Olmayan Anlatım)*

Merhaba takım, TonyAI projesini geliştirirken geleneksel yazılım ekipleri yerine **"Subagent" (Alt-Ajanlar)** adını verdiğimiz otonom yapay zeka asistanlarından oluşan bir takım kurguladık. Bu doküman, bu "dijital yazılım ekibinin" kimlerden oluştuğunu, kimin hangi işten sorumlu olduğunu ve takım içi işleyişi basitçe anlatmaktadır.

---

## "Subagent" (Yapay Zeka Takım Arkadaşı) Nedir?

Normalde bir projede mimar, arayüz tasarımcısı, backend geliştiricisi ve test uzmanı gibi farklı insanlar çalışır. Bizim modelimizde, her biri kendi alanında uzmanlaşmış yapay zeka birimleri (Subagent'lar) bu rolleri üstlenir. 

Ben (Ana Yapay Zeka / Tech Lead) takımın lideri olarak görev yapıyorum. Sadece kodları denetlemekle kalmıyor, aynı zamanda ürünün iş hedeflerine (Business Goals) ve bütçe/zaman kısıtlarına uygun ilerlediğinden emin oluyorum. İşleri parçalara bölüyor, ilgili Subagent'a veriyor ve vizyonunuzdan sapmadan kalite kontrolünü yapıyorum.

İşte TonyAI'ı hayata geçirecek 7 kişilik dijital yazılım ekibimiz:

---

## 1. "The Architect" (Sistem Mimarı ve Veritabanı Uzmanı)
**Kısa Tanım:** Ekibin mühendisi ve altyapı sorumlusudur.

*   **Ne İş Yapar?** 
    Ürünün temelini atar. Örneğin, "Şirketler, tesisler ve emisyon verileri nasıl kaydedilecek?" veya "Hangi kullanıcının hangi veriyi görmeye yetkisi var?" gibi kuralları belirler ve veritabanı tablolarını (excel sayfaları gibi düşünebilirsiniz) oluşturur.
*   **Bizim Projedeki Sorumluluğu:** 
    TonyAI'daki o karmaşık organizasyon yapısını (Holding > İştirak > Tesis) yönetecek altyapıyı **Supabase (PostgreSQL)** üzerinde kurmak. Emisyon formüllerinin hesaplama kurallarını ve güvenlik izinlerini (kim neyi görebilir - Supabase Auth) sisteme tanımlamak.
*   **Çıktısı (Ürettiği Şey):** Supabase veritabanı yapısı ve arka planda çalışan güvenli sistemin kuralları.

---

## 2. "The UI/UX Engineer" (Arayüz ve Kullanıcı Deneyimi Geliştiricisi)
**Kısa Tanım:** Ekibin vitrin tasarımcısı ve önyüz geliştiricisidir.

*   **Ne İş Yapar?**
    Kullanıcının gördüğü her şeyi inşa eder. Düğmelerin yerleşimi, menülerin tasarımı, renkler, sayfalar arası geçişler tamamen onun sorumluluğundadır.
*   **Bizim Projedeki Sorumluluğu:**
    Sizin ileteceğiniz **Figma tasarımlarını referans alarak**, yöneticilerin göreceği o şık "Dashboard" ekranını, pasta grafiklerini ve veri giriş formlarının dış görünüşünü kodlamak. Tailwind ve Shadcn gibi araçları kullanarak ürünü "premium" bir kurumsal yazılım gibi göstermek.
*   **Çıktısı (Ürettiği Şey):** Figma'daki tasarımların tıklanabilir, görsel olarak hazır fakat henüz içi veriyle dolmamış gerçek web sayfası halleri.

---

## 3. "The Integrator" (Birleştirici / Full-Stack Geliştirici)
**Kısa Tanım:** Ekibin tesisatçısı ve kablo bağlayıcısıdır.

*   **Ne İş Yapar?**
    "The Architect"in kurduğu altyapı (arka plan) ile "The UI/UX Engineer"ın yaptığı görsel ekranları (ön plan) birbirine bağlar. Düğmelerin gerçekten çalışmasını sağlar.
*   **Bizim Projedeki Sorumluluğu:**
    Sadece tekil veri girişlerini değil, holdinglerin geçmiş yıllara ait devasa Excel/CSV dosyalarını (Bulk Upload) sisteme tek tuşla ve hatasız bir şekilde aktaracak veri köprülerini kurmak. Ayrıca, kullanıcı veri giriş formuna "Elektrik: 100 kWh" yazıp "Kaydet"e bastığında, bu bilginin arka plana gitmesini, anında hesaplanıp ekrana "Tebrikler, emisyonunuz 20 tCO2e" olarak yansımasını sağlamak. Fatura (PDF) yükleme sistemlerini çalışır hale getirmek ve anomali durumlarında **Resend** üzerinden e-posta bildirimlerinin atılmasını sağlamak.
*   **Çıktısı (Ürettiği Şey):** Ekranda gördüğünüz verilerin Supabase ile konuşmasını ve işlemlerin sorunsuz yapılabilmesini sağlayan bağlantılar.

---

## 4. "The QA & Auditor" (Kalite Güvence ve Test Uzmanı)
**Kısa Tanım:** Ekibin denetmeni ve hata avcısıdır.

*   **Ne İş Yapar?**
    Sistemi kırmaya ve hataları bulmaya çalışır. Her şeyin teknik kurallara (özellikle karbon hesaplama standartlarına) uygun olduğunu teyit eder.
*   **Bizim Projedeki Sorumluluğu:**
    Karbon hesaplama formüllerinin doğru sonuç verip vermediğini test etmek. "Data Entry rolündeki biri, Super Admin'in alanına girebiliyor mu?" diye güvenlik denemeleri yapmak. Geçmiş yıllara göre %50'den fazla fark olan anomali verilerinin uyarı verip vermediğini kontrol etmek.
*   **Çıktısı (Ürettiği Şey):** Hatasız, çökmeyen ve güvenlik açıklarından arındırılmış, ISO 14064-1 standartlarına uygun sağlam bir ürün.

---

## 5. "The DevOps & Cloud Engineer" (Bulut Altyapı ve DevOps Uzmanı)
**Kısa Tanım:** Ekibin sistem yöneticisi ve yayın sorumlusudur.

*   **Ne İş Yapar?**
    Sistemin kurulacağı bulut altyapısını hazırlar. Kodların güvenle depolanmasını, otomatik test edilmesini ve kullanıcıların erişebileceği canlı internet ortamına (production) veya test ortamına (staging) otomatik olarak yüklenmesini (deploy) sağlar.
*   **Bizim Projedeki Sorumluluğu:**
    Supabase üzerinde Geliştirme (Development), Test (Staging) ve Canlı (Production) veritabanı ortamlarını kurmak. GitHub Actions ile otomatik yayınlama (CI/CD) süreçlerini tasarlamak. Projenin Docker konteynerlerini oluşturmak ve GCP veya Azure üzerinde güvenli bir şekilde barındırmak. KVKK ve GDPR gereksinimlerine uygun olarak verilerin bölge (Frankfurt/Avrupa vb.) sınırlarında tutulmasını altyapısal olarak garanti altına almak.
*   **Çıktısı (Ürettiği Şey):** Canlıda sorunsuz, hızlı çalışan, siber saldırılara karşı korunaklı, yedekleme ve altyapı kurulumları tamamlanmış sunucu sistemleri.

---

## 6. "The Security & Compliance Engineer" (Güvenlik ve Uyumluluk Uzmanı)
**Kısa Tanım:** Ekibin güvenlik şefi ve denetim bekçisidir.

*   **Ne İş Yapar?**
    Verinin "kapısında" durur. Hangi kullanıcının hangi şirketin verisini görüp göremeyeceğini kuralla bağlar ve bu kuralların hem yazılım hem de veritabanı seviyesinde (çift kilit) asla delinemeyeceğini garanti eder.
*   **Bizim Projedeki Sorumluluğu:**
    Holdinglerde en büyük korku, "A şirketinin verisinin B şirketine sızması"dır. Bu uzman; rol bazlı erişim (RBAC), Supabase RLS politikaları ve "kiracı izolasyonu" (tenant isolation) ile her holdingin verisini birbirinden tamamen yalıtır. Kapatılmış raporlama dönemlerinin bir daha değiştirilememesini (değişmezlik/immutability) ve KVKK/GDPR kurallarına uyumu garanti eder. (Bu sorumluluk önceden Test uzmanının içine sıkışmıştı; artık ayrı ve tam zamanlı bir uzmanlık.)
*   **Çıktısı (Ürettiği Şey):** Denetçilerin (KPMG, PwC vb.) tam not vereceği, veri sızıntısına ve yetki aşımına karşı çift katmanlı korunan, yasal olarak uyumlu bir sistem.

---

## 7. "The Data & Emission Factor Engineer" (Veri ve Emisyon Faktörü Uzmanı)
**Kısa Tanım:** Ekibin karbon bilimci ve veri kürasyon uzmanıdır.

*   **Ne İş Yapar?**
    Karbon hesaplamasının kalbindeki "katsayıları" (emisyon faktörleri) yönetir. "1 kWh elektrik kaç kilo karbon eder?" sorusunun ülkeye ve yıla göre değişen doğru cevabını sisteme yükler ve günceller.
*   **Bizim Projedeki Sorumluluğu:**
    DEFRA (İngiltere), Türkiye Ulusal ve AIB (Avrupa) gibi resmi faktör kütüphanelerini kaynağı ve lisansıyla birlikte sisteme işler. En kritik kuralı sağlar: **2023 verisi her zaman 2023 katsayısıyla hesaplanır; gelecekte katsayı değişse bile geçmiş raporlar asla değişmez** (faktör versiyonlama). Ayrıca farklı birimlerin (m³, MWh, litre) doğru çevrilmesini ve hesaplamaların ISO 14064-1 / GHG Protocol'e uygunluğunu denetler.
*   **Çıktısı (Ürettiği Şey):** Bilimsel olarak doğru, kaynağı belli, denetlenebilir ve yıllar içinde tutarlı kalan bir emisyon hesaplama temeli.

---

## İş Akışı (Örnek: Dashboard Yapımı)

Bu ekibin nasıl birlikte çalıştığını bir örnekle anlatalım:
1.  **Hazırlık:** İlk olarak **The DevOps & Cloud Engineer** çalışır. Tek çatı (Turborepo monorepo) iskeletini ve Supabase veritabanı ortamlarını oluşturur, GitHub reposunu kurar ve projeyi canlıya çıkmaya hazır hale getirir.
2.  **Tasarım:** Ardından **The UI/UX Engineer** çalışır ve Dashboard'un görselini, boş tabloları ve grafikleri ekrana çizer.
3.  **İnsan Onayı (Human-in-the-Loop):** Görseller ve ekran akışları gerçek kodlanmadan önce Product Owner'a (Size) sunulur. Onayınız veya revizyon talepleriniz alınır. Bu adım, yanlış bir şey inşa ederek zaman ve kaynak israf etmemizi önler.
4.  **Altyapı:** Onay sonrası **The Architect** devreye girer ve "Holding'in emisyon verileri nereden çekilecek, hesaplama nasıl yapılacak?" kurgusunu hazırlar, veritabanı tablolarını tasarlar.
5.  **Güvenlik Temeli:** **The Security & Compliance Engineer** bu tabloların üzerine erişim kurallarını (RBAC + RLS) kurar; her şirketin verisinin birbirinden yalıtıldığını ve denetim izinin değişmez olduğunu garanti eder.
6.  **Faktör Hazırlığı:** **The Data & Emission Factor Engineer** doğru emisyon katsayılarını (ülke/yıl bazlı) sisteme yükler ki hesaplama motoru gerçek ve denetlenebilir sonuçlar üretsin.
7.  **Entegrasyon:** Ardından **The Integrator** bu grafikleri ve ekranları arka plandaki gerçek verilerle bağlar, veritabanı bağlantılarını kurar ve sistemi canlandırır.
8.  **Test:** Son olarak **The QA & Auditor** sisteme girer, yanlış veriler girmeye çalışarak hesaplamaların, yetkilendirmelerin ve görsellerin doğru tepki verdiğini test eder.
9.  **Dağıtım:** QA onayı sonrası **The DevOps & Cloud Engineer** son kodları canlı sunuculara (GCP/Azure) otomatik olarak aktarır ve kullanıcıların hizmetine sunar.

Ben (Ana Yapay Zeka) ise bu 7 ajanı sırayla görevlendirip süreci yöneterek ürünün baştan sona eksiksiz çıkmasını sağlıyor olacağım.

