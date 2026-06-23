# birlikte — film gecesi

Sevgilinle telefon/PC fark etmeksizin aynı anda video izleyip sohbet edebileceğin
küçük bir "watch party" sitesi. Firebase Realtime Database üzerinden çalışır,
sunucu kodu yok — sadece statik dosyalar.

## Dosyalar
- `index.html` — sayfa iskeleti
- `style.css` — görsel tasarım
- `app.js` — tüm mantık (oda, kuyruk, senkron oynatma, sohbet)
- `firebase-config.js` — **buraya kendi Firebase config'ini yapıştıracaksın**

## 1) Firebase projesi kur (5 dakika)
1. https://console.firebase.google.com → "Add project" → bir isim ver, devam et.
2. Sol menüden **Build > Realtime Database** → **Create Database**.
   - Konum seç (Europe önerilir, Türkiye'ye yakın).
   - Kurallarda şimdilik "test mode" seçebilirsin, aşağıda gerçek kuralları vereceğim.
3. Sol üstte ⚙️ **Project settings > General** → en altta "Your apps" → **</> (Web)** ikonuna tıkla,
   bir takma ad ver, "Register app" de.
4. Sana çıkan `firebaseConfig = {...}` objesini kopyala.

## 2) Config'i yapıştır
`firebase-config.js` dosyasını aç, `BURAYA_YAPISTIR` yazan her yeri kendi değerlerinle değiştir.

## 3) Güvenlik kuralları (önemli)
Bu site giriş/şifre sistemi kullanmıyor — oda kodunu bilen herkes girebilir
(6 karakter, ~1 milyar kombinasyon, tahmin edilmesi pratik değil ama tamamen
herkese açık bir üründe yeterli olmaz). Realtime Database > **Rules** sekmesine
şunu yapıştır, "Publish" de:

```json
{
  "rules": {
    "rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true,
        "chat": {
          "$msgId": {
            ".validate": "newData.hasChildren(['name','text','sentAt']) && newData.child('text').isString() && newData.child('text').val().length <= 500"
          }
        }
      }
    },
    "$other": {
      ".read": false,
      ".write": false
    }
  }
}
```

Bu kurallar erişimi sadece `/rooms/...` altına kilitler, kök veritabanına ya da
başka yollara okuma/yazma yapılamaz; chat mesajları için temel doğrulama ekler.
Tamamen halka açık, kaydolma olan bir ürün yapacaksan Firebase Authentication
ekleyip kuralları kullanıcıya göre sıkılaştırman gerekir — iki kişilik kullanım
için bu yeterli.

## 4) Yayınla
En basit yol — Firebase Hosting:
```bash
npm install -g firebase-tools
firebase login
cd bu-klasor
firebase init hosting   # public dizini olarak bu klasörü seç, tek sayfa app sorusuna "No" de
firebase deploy
```
Sana bir `https://senin-projen.web.app` linki verecek, telefonundan da PC'nden de açabilirsin.

Alternatif: Netlify ya da Vercel'e bu klasörü sürükleyip bırakman da yeterli,
hepsi statik dosya barındırıyor.

## Nasıl çalışıyor
- **İsim → Oda Oluştur / Katıl**: Oluşturunca rastgele 6 karakterli kod üretilir.
- **Link ekleme**: YouTube, Google Drive ya da direkt video dosyası (mp4 vb.) linki
  yapıştırıp + ile listeye eklersin, sırayla oynatılır, video bitince otomatik sıradakine geçer.
- **Senkron oynatma**: Biri oynat/durdur/ileri-geri yaptığında, konum ve zaman damgası
  Firebase'e yazılır; diğer taraf bunu okuyup kendi oynatıcısını aynı noktaya getirir.
- **Sohbet**: Realtime Database üzerinden anlık, oda geçmişi son 100 mesajla sınırlı.

## Bilinen sınırlamalar
- **Google Drive linkleri**: Drive'ın doğrudan video akışı bazı büyük dosyalarda
  ("virüs taraması yapılamadı" sayfası) çalışmayabilir. Dosyanın paylaşım ayarının
  "Bağlantıya sahip olan herkes" olduğundan emin ol; sorun yaşarsan dosyayı küçültmeyi
  ya da doğrudan mp4 barındırma (örn. Google Drive yerine başka bir dosya barındırma)
  denemeni öneririm.
- YouTube'da bölgesel/yaş kısıtlı ya da "yerleştirmeye izin verilmeyen" videolar
  oynatılamaz (YouTube'un kendi kısıtlaması).
