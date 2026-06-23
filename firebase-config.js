// =====================================================================
// Firebase Console > Project Settings > General > "Your apps" kısmından
// aldığın config objesini AŞAĞIDAKİ yer tutucuların yerine yapıştır.
// Realtime Database'i de Console'dan "Build > Realtime Database" yoluyla
// oluşturduğundan emin ol (databaseURL bu adımdan sonra oluşur).
// =====================================================================
const firebaseConfig = {
  apiKey: "AIzaSyBdf8Hha69vz6iq4UAwybhBRuvg0ZslOFM",
  authDomain: "watchprty-51b47.firebaseapp.com",
  databaseURL: "https://watchprty-51b47-default-rtdb.firebaseio.com",
  projectId: "watchprty-51b47",
  storageBucket: "watchprty-51b47.firebasestorage.app",
  messagingSenderId: "786917847296",
  appId: "1:786917847296:web:d8291d32b81c15b0bd43e5"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// =====================================================================
// YouTube Data API v3 anahtarı — SADECE "oynatma listesi (playlist)" linkleri
// yapıştırıldığında listedeki videoları otomatik kuyruğa eklemek için kullanılır.
// Google Cloud Console > APIs & Services > Credentials kısmından ücretsiz bir
// anahtar oluşturup "YouTube Data API v3" ile sınırlayabilirsin.
// Boş bırakılırsa SADECE bu özellik devre dışı kalır, uygulamanın geri kalanı
// (tekil video linkleri dahil) normal şekilde çalışmaya devam eder.
// NOT: Bu bir istemci-taraflı (tarayıcıda görünen) anahtardır — bu app'in
// statik/sunucusuz yapısı gereği normaldir; anahtarı sadece bu API ile ve
// (mümkünse) kendi alan adınla sınırlamanı öneririz.
// =====================================================================
const YOUTUBE_API_KEY = "";
