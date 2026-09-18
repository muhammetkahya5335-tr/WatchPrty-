// =====================================================================
// Firebase yapılandırması — watch-with-us projesi
// =====================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCxOf7KgKI1iOD1b0HP2t9EQXKs_R50mPo",
  authDomain: "watch-with-us.firebaseapp.com",
  databaseURL: "https://watch-with-us-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "watch-with-us",
  storageBucket: "watch-with-us.firebasestorage.app",
  messagingSenderId: "241267547287",
  appId: "1:241267547287:web:4f1c569e23ca9d9b8c5dd2",
  measurementId: "G-RV6XTE6KPF"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// =====================================================================
// YouTube Data API v3 anahtarı — SADECE "oynatma listesi (playlist)" linkleri
// yapıştırıldığında listedeki videoları otomatik kuyruğa eklemek için kullanılır.
// Boş bırakılırsa SADECE bu özellik devre dışı kalır.
// =====================================================================
const YOUTUBE_API_KEY = "";

// =====================================================================
// Canlı yayın (kendi cihazındaki videoyu odaya yayınlama) için ICE sunucuları.
// STUN çoğu ağda yeter. Bazı ağlarda (kurumsal Wi-Fi, bazı mobil operatörler)
// bağlantı kurulamazsa buraya bir TURN sunucusu ekle, örn:
//   { urls: 'turn:turn.ornek.com:3478', username: 'kullanici', credential: 'sifre' }
// =====================================================================
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
