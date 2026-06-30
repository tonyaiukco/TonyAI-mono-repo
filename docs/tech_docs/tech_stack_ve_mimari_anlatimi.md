# TonyAI - Teknoloji Yığını (Tech Stack) ve Mimari Rehberi
*(Product Owner ve Product Manager'lar için Teknik Olmayan Anlatım)*

Merhaba takım, bu doküman teknik terimlerin arkasında yatan mantığı ve TonyAI için neden bu teknolojileri seçtiğimizi en anlaşılır şekilde açıklamak için hazırlanmıştır. Hedefimiz, ürün kararlarını alırken arka planda nelerin çalıştığını net bir şekilde görebilmenizdir.

---

## 1. Genel Mimari: "Başsız" (Headless) Sistem Nedir?

TonyAI'ı bir **restoran** gibi düşünebiliriz:
*   **Müşteri Alanı (Frontend):** Müşterilerin (kullanıcıların) menüyü gördüğü, sipariş verdiği ve yemek yediği şık ve modern alan.
*   **Mutfak (Backend):** Siparişlerin (verilerin) alındığı, yemeklerin (hesaplamaların) kurallara göre pişirildiği ve hazırlandığı kapalı alan.

Biz TonyAI'da **Headless (Başsız)** mimari kullanacağız. Yani müşteri alanı (Frontend) ile mutfak (Backend) birbirinden tamamen bağımsız çalışacak. İkisi birbiriyle sadece "sipariş fişleri" (JSON adı verilen basit veri paketleri) aracılığıyla haberleşecek. 
**Bunun Bize Faydası Ne?** Yarın öbür gün bir mobil uygulama (iOS/Android) yapmak istersek, mutfağı (Backend) hiç değiştirmeden sadece yeni bir müşteri alanı (Mobil Frontend) açarak yola devam edebiliriz. Bu, sistemin çok daha hızlı, esnek ve geleceğe hazır olmasını sağlar.

### Tek Çatı (Monorepo): Aynı Bina, Ayrı İstasyonlar

Mutfak (Backend) ile salon (Frontend) ayrı *çalışsa* da, ikisini **tek bir binada (tek kod deposu / monorepo)** topluyoruz. Buna **Turborepo** diyoruz. Restoranın salonu, mutfağı ve deposu aynı çatı altında ama ayrı istasyonlar gibi:
*   **Salon** (`apps/web`) → Next.js önyüz
*   **Mutfak** (`apps/api`) → NestJS backend
*   **Ortak Sözlük** (`packages/shared-types`) → salon ile mutfağın aynı dili konuşması için ortak veri tanımları

**Bunun Bize Faydası Ne?** Salon ve mutfak aynı "menü tanımını" paylaştığı için yanlış anlaşılma (veri uyumsuzluğu) yaşanmaz; ekipler aynı depo üzerinde paralel ve hızlı çalışır; her şey tek komutla birlikte test edilip yayınlanabilir.

---

## 2. Kullanıcı Arayüzü Teknolojileri (Frontend - Müşteri Alanı)

Kullanıcıların ekranda gördüğü, tıkladığı ve etkileşime girdiği her şey bu teknolojilerle yapılır.

### Next.js ve React
*   **Nedir?** Modern web sitelerinin temel yapı taşlarıdır. Facebook, Netflix gibi devlerin kullandığı teknolojilerdir.
*   **Neden Seçtik?** TonyAI bir "kurumsal SaaS (Yazılım Hizmeti)" ürünü. Tıklamalar arası beklemelerin olmaması, ekranların anında yüklenmesi ve Google'da (SEO) iyi bulunabilmesi için Next.js şu an sektördeki en iyi araçtır. 
*   **Sizin İçin Anlamı:** Kullanıcılar Excel dosyalarında veya eski moda panellerde beklerken yaşadıkları yavaşlığı burada yaşamayacak. Sistem su gibi akacak.
*   **Zayıf İnternet Direnci:** Fabrika veya uzak tesislerdeki kullanıcıların interneti kopsa bile, sistemin "çöktü" hissi vermemesi ve verileri önbellekte (cache) tutarak internet geldiğinde arka planda gönderebilmesi için bu modern altyapı kritik bir avantaj sunar.

### Tailwind CSS ve Shadcn UI
*   **Nedir?** Web sitesinin makyajı ve hazır mobilyalarıdır. Tailwind renkleri ve boşlukları ayarlar, Shadcn UI ise bize hazır, çok şık butonlar, tablolar ve menüler verir.
*   **Neden Seçtik?** Tasarımcıların "pixel-perfect" (kusursuz) dediği, Apple veya Stripe gibi devlerin sitelerindeki o premium, pahalı ve güvenilir hissiyatı çok hızlı kodlamamızı sağlar.
*   **Sizin İçin Anlamı:** Ürünümüz "ucuz" veya "basit" görünmeyecek. Müşteri (Büyük bir holding yöneticisi) panele girdiğinde, milyon dolarlık bir yazılım kullanıyor hissiyatını alacak.

### Recharts
*   **Nedir?** Ekrandaki o güzel pasta grafiklerini (Donut chart), çubuk grafikleri (Bar chart), alan ve ağaç grafiklerini (Treemap) çizen çizim aracıdır.
*   **Neden Seçtik?** Tasarımımızda yer alan tüm karmaşık emisyon kırılımlarını, iştirak karşılaştırmalarını ve trend analizlerini yöneticilerin bir bakışta anlayabileceği şık ve etkileşimli grafiklere dönüştürmek için.

---

## 3. Arka Plan Teknolojileri (Backend - Mutfak ve Beyin)

Verilerin toplandığı, karbon ayak izinin hesaplandığı ve güvenliğin sağlandığı görünmez kısımdır.

### Node.js (NestJS) ve Python
*   **Nedir?** Mutfağımızın baş aşçılarıdır.
*   **Neden Seçtik?** Ana mutfağı ve veri trafiğini yönetmesi için kurumsal standartlarda çok sağlam ve hızlı olan **NestJS** (Node.js) altyapısını seçtik. İlerleyen fazlarda yapay zeka ve makine öğrenmesi tabanlı karbon tahminleme modelleri eklediğimizde, bu modelleri çalıştırmak üzere yanına bir **Python** yardımcısı ekleyeceğiz.
*   **Sizin İçin Anlamı:** Holdinglerin binlerce tesisinden aynı anda veri girildiğinde sistemin çökmeden, anında doğru emisyon sonucunu (tCO2e) hesaplamasını ve gelecekte yapay zeka özelliklerine sorunsuzca evrilmesini sağlar.

---

## 4. Veritabanı ve Depolama (Kiler ve Kasa)

Verileri asla kaybetmemek ve hızlıca bulmak için kullandığımız teknolojilerdir.

### Supabase (PostgreSQL ve Kimlik Doğrulama)
*   **Nedir?** Hem dünyanın en güvenilir veritabanı olan PostgreSQL'i, hem de kullanıcı giriş-çıkışlarını (Auth) yöneten hepsi bir arada bir platformdur. Bilgilerin tutulduğu devasa, siber güvenlikli bir kilitli kasa gibi düşünebilirsiniz.
*   **Neden Seçtik?** TonyAI'da Holding > İştirak > Tesis gibi karmaşık hiyerarşiler var. Supabase sayesinde "Ahmet Bey, B Şirketi'nin verilerini görebilsin ama C Şirketi'ni göremesin" gibi kritik güvenlik kurallarını kolayca ve asla delinemez şekilde kurabiliyoruz. Ayrıca giriş işlemleri için ekstra bir altyapı kurmamıza gerek kalmıyor.
*   **Sizin İçin Anlamı:** Buna sektörde "Sıfır Güven (Zero Trust)" ve "Rol Bazlı Erişim (RBAC)" denir. Supabase sayesinde sadece yetki sınırlarını çizmekle kalmıyoruz, aynı zamanda hangi kullanıcının hangi veriyi saat kaçta değiştirdiğinin "Denetim İzini (Audit Trail)" siber güvenlikli bir şekilde tutuyoruz. Bu, bağımsız denetçilerin (KPMG, PwC vb.) platformumuza tam not vermesini sağlayacak temel özelliktir.
*   **Çift Kilit Yaklaşımı:** Güvenliği tek bir yere bırakmıyoruz. Birincil kilit uygulama (NestJS) seviyesinde yetki kontrolüdür; ikincil savunma hattı ise veritabanı (Supabase RLS) seviyesindeki kilittir. Biri bir şekilde atlansa bile diğeri devrede kalır — bu da "A şirketinin verisi B şirketine sızar mı?" riskini en aza indirir.

### Supabase Storage (Dosya Depolama)
*   **Nedir?** Dosya depolama merkezidir. 
*   **Neden Seçtik?** Kullanıcılar elektrik faturalarını (kanıt/evidence) sisteme PDF veya JPEG olarak yükleyecekler. Bu dosyaları veritabanında tutmak sistemi yavaşlatır. Bunun yerine onları sınırsız kapasiteli Supabase Storage dolaplarına koyarız.

### Resend (E-posta ve Bildirimler)
*   **Nedir?** Kullanıcılara giden otomatik e-postaları gönderen kurye sistemidir.
*   **Neden Seçtik?** "Yeni anomali tespit edildi", "Tesis verisi girildi" gibi otomatik bildirimleri holding yöneticilerinin spam (gereksiz) kutusuna düşmeden, en hızlı ve şık şekilde ulaştırmak için kullanıyoruz.

### PDF & Excel Raporlama Fabrikası
*   **Nedir?** Ekranda görülen tüm emisyon tablolarını, grafiklerini ve yasal metodoloji notlarını tek tıkla resmi PDF ve Excel dökümanlarına dönüştüren otomatik matbaadır.
*   **Neden Seçtik?** Kurumsal müşterilerimiz bu dökümanları denetim firmalarına (PwC, KPMG vb.) sunacak. Bu yüzden hata payı olmayan, görsel olarak kusursuz dökümanlar üretmek için sunucu tarafında çalışan özel PDF ve Excel dönüştürücüler kullanıyoruz.

### Önbellek Sistemi (Hızlı Bellek)
*   **Nedir?** Çok sık kullanılan bilgileri (örneğin elektrik emisyon katsayıları gibi sabit verileri) her seferinde kilitli kasadan (veritabanı) aramak yerine tezgahın üstünde hazır tutan "hızlı bellek" yapısıdır.
*   **Neden Seçtik?** Kullanıcılar veri girişi yaparken canlı emisyon hesaplamalarının milisaniyeler içinde gerçekleşmesi ve sistemin göz kırpma hızında yanıt vermesi için.

### DevOps, Canlı Yayın (GCP veya Azure) ve Dijital DevOps Ajanımız
*   **Nedir?** Yazılım kodlarımızın güvenle depolandığı merkez ve bu kodları alıp internette kurumsal standartlarda canlı yayına alan bulut altyapısıdır. Bu süreci yönetmek ve hatasız sürdürmek için ekibimize **The DevOps & Cloud Engineer** adında otonom bir yapay zeka ajanı katılmıştır.
*   **Neden Seçtik?** Altyapıyı otomatik kurabilmek, geliştirme-test-canlı ortamlarını birbirine karıştırmadan yönetmek ve GCP/Azure gibi kurumsal bulut sağlayıcılarının gücünden yararlanmak için. DevOps ajanımız sayesinde sunucu yönetimi insansız ve kesintisiz yürütülür.
*   **KVKK ve GDPR Uyumluluğu:** Kurumsal holdingler verilerinin nerede tutulduğuna çok önem verir. DevOps ajanımız tarafından yapılandırılan bulut altyapısı sayesinde, müşteri verilerini yasal zorunluluklara göre Avrupa'da (Frankfurt) veya Türkiye'de barındıracak şekilde izole edebiliriz. Bu, satış aşamasında kurumsal IT departmanlarından kolayca onay almamızı sağlar.

---

## Özetle Ne Kazanıyoruz?

Seçtiğimiz bu teknoloji yığını sayesinde TonyAI:
1.  **Hızlıdır:** Tıklamalar anında tepki verir.
2.  **Güvenilirdir:** Holding verileri birbirine karışmaz, veri güvenliği en üst seviyededir.
3.  **Ölçeklenebilirdir:** Bugün 10 şirkete, yarın 10.000 şirkete hizmet verecek şekilde tasarlanmıştır. Altyapıyı baştan yıkıp yapmamıza gerek kalmayacaktır.
4.  **Premium Hissiyat Verir:** Kullanıcı deneyimi (UX) modern ve şıktır, kurumsal müşteride anında güven uyandırır.
