// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyBdf8Hha69vz6iq4UAwybhBRuvg0ZslOFM",
    authDomain: "watchprty-51b47.firebaseapp.com",
    databaseURL: "https://watchprty-51b47-default-rtdb.firebaseio.com",
    projectId: "watchprty-51b47",
    storageBucket: "watchprty-51b47.firebasestorage.app",
    messagingSenderId: "786917847296",
    appId: "1:786917847296:web:d8291d32b81c15b0bd43e5"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const params = new URLSearchParams(window.location.search);
const uName = params.get('user') || "Anonim";
const rCode = params.get('room') || "TEST";
const role  = params.get('role') || "guest";

let player;
let currentPlaylistIndex = 0;
let micActive = false;
let localStream = null;
let peers = {}; // peerId -> RTCPeerConnection

document.getElementById('roomLabel').innerText = "ODA: " + rCode;
document.getElementById('roleLabel').innerText = "ROL: " + role.toUpperCase();

// ── VIDEO TİPİ VE ID ÇIKARMA ─────────────────────────────────────────────────
// Döner: { type: 'youtube'|'drive', id: '...' } veya null
function parseVideoUrl(url) {
    if (!url) return null;

    // YouTube
    const ytMatch = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) return { type: 'youtube', id: ytMatch[1] };

    // Google Drive — çeşitli format'lar:
    // drive.google.com/file/d/FILE_ID/view
    // drive.google.com/open?id=FILE_ID
    // docs.google.com/file/d/FILE_ID/...
    const driveMatch = url.match(/(?:drive\.google\.com\/file\/d\/|drive\.google\.com\/open\?id=|docs\.google\.com\/file\/d\/)([a-zA-Z0-9_-]+)/);
    if (driveMatch) return { type: 'drive', id: driveMatch[1] };

    return null;
}

// Geriye dönük uyumluluk (sadece YT ID döner)
function extractVideoID(url) {
    const p = parseVideoUrl(url);
    return (p && p.type === 'youtube') ? p.id : null;
}

// ── MESAJ GÖNDERME ────────────────────────────────────────────────────────────
function sendChat() {
    const inp = document.getElementById('chatInp');
    const text = inp.value.trim();
    if (!text) return;
    db.ref('rooms/' + rCode + '/messages').push({
        user: uName,
        text: text,
        time: Date.now()
    });
    inp.value = '';
    inp.focus(); // klavye açık kalsın
}

// ── ANA UYGULAMA ──────────────────────────────────────────────────────────────
function initApp() {
    const roomRef = db.ref('rooms/' + rCode);

    // Mesajları dinle
    roomRef.child('messages').on('child_added', (snapshot) => {
        const m = snapshot.val();
        const flow = document.getElementById('chat-flow');
        const div = document.createElement('div');
        div.className = 'msg';
        div.innerHTML = `<b>${escHtml(m.user)}</b>${escHtml(m.text)}`;
        flow.appendChild(div);
        flow.scrollTop = flow.scrollHeight;
    });

    // Senkronizasyon dinle
    roomRef.child('sync').on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        const parsed = parseVideoUrl(data.videoId);
        if (!parsed) return;

        if (parsed.type === 'youtube') {
            // Drive player varsa kaldır, YT player'a geç
            switchToYouTube(parsed.id);
            if (!player || !player.loadVideoById) return;
            if (player.getVideoData && player.getVideoData().video_id !== parsed.id) {
                player.loadVideoById(parsed.id);
            }
            if (role === 'guest') {
                const diff = Math.abs(player.getCurrentTime() - data.time);
                if (diff > 3) player.seekTo(data.time, true);
                data.state === 1 ? player.playVideo() : player.pauseVideo();
            }
        } else if (parsed.type === 'drive') {
            switchToDrive(parsed.id, data);
        }
    });

    // Host: her 2 saniyede durumu yaz
    if (role === 'host') {
        const playlist = JSON.parse(localStorage.getItem('playlist') || '[]');
        if (playlist.length > 0) {
            // İlk URL'yi olduğu gibi yaz (type bilgisi korunuyor)
            roomRef.child('sync').update({ videoId: playlist[0], time: 0, state: -1 });
            roomRef.child('playlist').set(playlist);

            // İlk videoyu oynat
            const parsed = parseVideoUrl(playlist[0]);
            if (parsed && parsed.type === 'youtube') {
                loadYouTubeById(parsed.id);
            } else if (parsed && parsed.type === 'drive') {
                switchToDrive(parsed.id, { time: 0, state: -1 });
            }
        }

        setInterval(() => {
            const driveEl = document.getElementById('driveVideo');
            if (driveEl) {
                roomRef.child('sync').update({
                    time: driveEl.currentTime,
                    state: driveEl.paused ? 2 : 1
                });
            } else if (player && player.getCurrentTime) {
                roomRef.child('sync').update({
                    time: player.getCurrentTime(),
                    state: player.getPlayerState()
                });
            }
        }, 2000);
    }

    // WebRTC: diğer kullanıcıların signal'larını dinle
    listenForSignals();
}

// ── YOUTUBE API READY ─────────────────────────────────────────────────────────
function onYouTubeIframeAPIReady() {
    // Player nesnesini oluştur ama video yükleme initApp'e bırak
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '',
        playerVars: { controls: (role === 'host' ? 1 : 0), rel: 0, playsinline: 1 },
        events: { onReady: initApp }
    });
}

// ── PLAYER SWITCH FONKSİYONLARI ───────────────────────────────────────────────
let currentVideoType = null; // 'youtube' | 'drive'

function switchToYouTube(videoId) {
    if (currentVideoType === 'youtube') return; // zaten YT modunda
    currentVideoType = 'youtube';
    // Drive elementini kaldır
    const driveWrap = document.getElementById('driveWrap');
    if (driveWrap) driveWrap.remove();
    // YT player div'ini göster
    document.getElementById('player').style.display = 'block';
    loadYouTubeById(videoId);
}

function loadYouTubeById(videoId) {
    if (!player || !player.loadVideoById) return;
    if (player.getVideoData().video_id !== videoId) {
        player.loadVideoById(videoId);
    }
}

function switchToDrive(fileId, syncData) {
    currentVideoType = 'drive';
    document.getElementById('player').style.display = 'none';

    let wrap = document.getElementById('driveWrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'driveWrap';
        wrap.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;background:#000;';
        document.querySelector('.video-container').appendChild(wrap);
    }

    if (wrap.dataset.fileId === fileId) return;
    wrap.dataset.fileId = fileId;

    // Drive /preview iframe — en güvenilir yöntem.
    // Dosyanın "Bağlantıya sahip herkes görüntüleyebilir" olması şart.
    // rm=minimal parametresi Drive UI chrome'unu kaldırır, sadece video kalır.
    const embedUrl = `https://drive.google.com/file/d/${fileId}/preview?rm=minimal`;

    wrap.innerHTML = `
        <iframe
            id="driveFrame"
            src="${embedUrl}"
            width="100%"
            height="100%"
            style="border:none;display:block;"
            allow="autoplay; fullscreen"
            allowfullscreen>
        </iframe>
        <div id="driveOverlay" style="
            position:absolute;bottom:0;left:0;right:0;
            background:linear-gradient(transparent,rgba(0,0,0,0.85));
            color:#aaa;font-size:11px;text-align:center;
            padding:6px;pointer-events:none;font-family:sans-serif;">
            📁 Google Drive — host videoyu kontrol eder
        </div>`;

    // Drive iframe içine JS erişimi yok (cross-origin).
    // Senkronizasyon notu: host iframe dışından kontrol edilemez,
    // bu yüzden Drive videolarında tüm izleyiciler aynı URL'yi yükler
    // ve host chat üzerinden "şimdi başlatın" diyerek koordine eder.
    if (role === 'host') {
        setTimeout(() => appendMsg('', '📌 Drive videosu yüklendi. Hazır olduğunuzda sohbetten "HAZIR" yazın, hep birlikte başlatın.', true), 800);
    }
}

// ── MİKROFON / SESLİ SOHBET ──────────────────────────────────────────────────
async function toggleMic() {
    const btn = document.getElementById('micBtn');
    if (!micActive) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            micActive = true;
            btn.classList.add('active');
            addSystemMsg('🎙️ Mikrofon açıldı');
            announcePresence();
        } catch (e) {
            addSystemMsg('⚠️ Mikrofon erişimi reddedildi');
        }
    } else {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
        micActive = false;
        btn.classList.remove('active');
        addSystemMsg('🔇 Mikrofon kapatıldı');
        // Peer bağlantıları kapat
        Object.values(peers).forEach(pc => pc.close());
        peers = {};
        // Presence sil
        db.ref('rooms/' + rCode + '/voice/' + uName).remove();
    }
}

// ── WebRTC: Presence & Signaling ─────────────────────────────────────────────
// FIX 1: Presence yazıldıktan SONRA diğerlerini dinle (race condition önleme)
// FIX 2: listenForSignals initApp'de çağrılıyor, burada tekrar çağırma
// FIX 3: candidate'lar offer/answer'dan önce gelebilir → kuyrukla
// FIX 4: ICE TURN sunucuları eklendi (NAT arkası cihazlar için)
// FIX 5: handleOffer'da track ekleme setRemoteDescription'dan ÖNCE yapılıyor

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        // Ücretsiz TURN — NAT arkası / mobil operatör ağları için şart
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// candidate'lar remote description gelmeden önce gelebilir, biriktir
const pendingCandidates = {};

function announcePresence() {
    const myRef = db.ref('rooms/' + rCode + '/voice/' + uName);
    myRef.set({ online: true, ts: Date.now() });
    myRef.onDisconnect().remove();

    // Presence yazıldıktan sonra odadaki herkese offer gönder
    db.ref('rooms/' + rCode + '/voice').once('value', snap => {
        snap.forEach(child => {
            const otherId = child.key;
            if (otherId !== uName) createOffer(otherId);
        });
    });

    // Yeni gelen biri olursa onlara da offer gönder
    db.ref('rooms/' + rCode + '/voice').on('child_added', snap => {
        const otherId = snap.key;
        if (otherId !== uName && !peers[otherId]) {
            createOffer(otherId);
        }
    });
}

function createOffer(targetId) {
    if (peers[targetId]) return; // zaten bağlı
    const pc = createPeerConnection(targetId);
    pc.createOffer({ offerToReceiveAudio: true })
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            db.ref('rooms/' + rCode + '/signals/' + targetId + '/' + uName).push({
                type: 'offer', sdp: pc.localDescription.sdp
            });
        })
        .catch(e => console.error('createOffer hata:', e));
}

function listenForSignals() {
    db.ref('rooms/' + rCode + '/signals/' + uName).on('child_added', (snap) => {
        const fromId = snap.key;
        // Her yeni mesajı işle
        snap.on('child_added', msgSnap => {
            const msg = msgSnap.val();
            if (!msg) return;
            msgSnap.ref.remove();

            if (msg.type === 'offer')         handleOffer(fromId, msg);
            else if (msg.type === 'answer')   handleAnswer(fromId, msg);
            else if (msg.type === 'candidate') handleCandidate(fromId, msg);
        });
    });
}

function createPeerConnection(peerId) {
    if (peers[peerId]) peers[peerId].close();
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peers[peerId] = pc;
    pendingCandidates[peerId] = [];

    // Kendi ses track'ini ekle (mikrofon açıksa)
    if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // ICE candidate → Firebase'e gönder
    pc.onicecandidate = e => {
        if (e.candidate) {
            db.ref('rooms/' + rCode + '/signals/' + peerId + '/' + uName).push({
                type: 'candidate',
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex
            });
        }
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') appendMsg('', '🔊 ' + peerId + ' sesli bağlandı', true);
        if (s === 'disconnected' || s === 'failed') {
            appendMsg('', '🔇 ' + peerId + ' bağlantısı kesildi', true);
            const a = document.getElementById('audio_' + peerId);
            if (a) a.remove();
            delete peers[peerId];
        }
    };

    // Karşı tarafın sesi gelince <audio> elementine bağla
    pc.ontrack = e => {
        let audio = document.getElementById('audio_' + peerId);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'audio_' + peerId;
            audio.autoplay = true;
            audio.playsInline = true;
            document.body.appendChild(audio);
        }
        audio.srcObject = e.streams[0];
        // Mobil tarayıcıda autoplay bazen bloklanır, kullanıcı etkileşimi sonrası çal
        audio.play().catch(() => {
            document.addEventListener('touchstart', () => audio.play(), { once: true });
            document.addEventListener('click',      () => audio.play(), { once: true });
        });
    };

    return pc;
}

async function handleOffer(fromId, msg) {
    const pc = createPeerConnection(fromId);

    // FIX: track ÖNCE ekle, sonra remoteDescription set et
    if (localStream) {
        localStream.getTracks().forEach(t => {
            if (!pc.getSenders().find(s => s.track === t)) pc.addTrack(t, localStream);
        });
    }

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });

    // Birikmiş candidate'leri uygula
    for (const c of (pendingCandidates[fromId] || [])) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
    pendingCandidates[fromId] = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    db.ref('rooms/' + rCode + '/signals/' + fromId + '/' + uName).push({
        type: 'answer', sdp: pc.localDescription.sdp
    });
}

async function handleAnswer(fromId, msg) {
    const pc = peers[fromId];
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });

    // Birikmiş candidate'leri uygula
    for (const c of (pendingCandidates[fromId] || [])) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
    pendingCandidates[fromId] = [];
}

async function handleCandidate(fromId, msg) {
    const pc = peers[fromId];
    const cand = { candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex };

    if (!pc || !pc.remoteDescription) {
        // Remote description henüz gelmedi, biriktir
        if (!pendingCandidates[fromId]) pendingCandidates[fromId] = [];
        pendingCandidates[fromId].push(cand);
    } else {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
    }
}

// ── YARDIMCI ─────────────────────────────────────────────────────────────────
function addSystemMsg(text) {
    const flow = document.getElementById('chat-flow');
    const div = document.createElement('div');
    div.className = 'msg';
    div.style.borderColor = '#7000ff';
    div.style.color = '#aaa';
    div.style.fontSize = '12px';
    div.innerText = text;
    flow.appendChild(div);
    flow.scrollTop = flow.scrollHeight;
}

function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
