// Global değişkenler
let socket;
let isAdmin = false;
let currentRoom = null;
let username = '';

let player = null;
let videoType = null;
let heartbeatInterval;
let currentVideo = null;

// WebRTC
const peers = new Map();
let localStream = null;
let micActive = false;
let webrtcInitialized = false; // listener'ları bir kez eklemek için

// DOM referansları
const lobby = document.getElementById('lobby');
const app = document.getElementById('app');
const usernameInput = document.getElementById('usernameInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const lobbyError = document.getElementById('lobbyError');
const controls = document.getElementById('controls');
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const timeDisplay = document.getElementById('timeDisplay');
const playlistUl = document.getElementById('playlist');
const adminPanel = document.getElementById('adminPanel');
const videoLinkInput = document.getElementById('videoLinkInput');
const addBtn = document.getElementById('addBtn');
const videoContainer = document.getElementById('videoContainer');
const messagesDiv = document.getElementById('messages');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const micBtn = document.getElementById('micBtn');

const ytReady = new Promise(resolve => {
  window.onYouTubeIframeAPIReady = resolve;
});

// ------------------- LOBBY -------------------
createRoomBtn.addEventListener('click', () => {
  username = usernameInput.value.trim();
  if (!username) return (lobbyError.textContent = 'Kullanıcı adı gerekli');
  socket = io();
  socket.on('roomCreated', ({ roomCode, isAdmin: admin }) => {
    currentRoom = roomCode;
    isAdmin = admin;
    enterApp();
  });
  socket.emit('createRoom', { username });
});

joinRoomBtn.addEventListener('click', () => {
  const code = roomCodeInput.value.trim();
  username = usernameInput.value.trim();
  if (!code || !username) return (lobbyError.textContent = 'Kod ve isim şart');
  socket = io();
  socket.on('roomJoined', ({ roomCode, isAdmin: admin }) => {
    currentRoom = roomCode;
    isAdmin = admin;
    enterApp();
  });
  socket.on('error', ({ message }) => { lobbyError.textContent = message; });
  socket.emit('joinRoom', { roomCode: code, username });
});

function enterApp() {
  lobby.style.display = 'none';
  app.style.display = 'grid';

  if (isAdmin) {
    adminPanel.style.display = 'block';
  } else {
    adminPanel.style.display = 'none';
  }

  // Chat
  socket.on('chatMessage', addMessage);
  sendChatBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keypress', (e) => e.key === 'Enter' && sendChat());

  // Mikrofon
  micBtn.addEventListener('click', toggleMic);

  // Video olaylarını bağla
  bindVideoEvents();

  // Oda durumunu dinle (ilk yükleme)
  socket.on('roomState', (state) => {
    updatePlaylist(state.playlist, state.currentIndex);
    if (state.messages) {
      messagesDiv.innerHTML = '';
      state.messages.forEach(addMessage);
    }
    if (state.currentVideo) {
      loadVideo(state.currentVideo, false);
      if (state.currentVideo.time) seekVideo(state.currentVideo.time);
      if (state.currentVideo.isPlaying) playVideo();
      else pauseVideo();
    }
  });

  // Video yükleme
  socket.on('loadVideo', (data) => {
    updatePlaylist(null, data.index);
    loadVideo(data.video, true);
  });

  socket.on('playlistUpdate', (data) => updatePlaylist(data.playlist));
  socket.on('playlistEnded', () => alert('Oynatma listesi sona erdi.'));
}

// ------------------- CHAT -------------------
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chatMessage', text);
  chatInput.value = '';
}

function addMessage({ username, text }) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `<span class="user">${username}:</span> ${text}`;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ------------------- MİKROFON / WEBRTC -------------------
async function toggleMic() {
  if (!micActive) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micActive = true;
      micBtn.classList.add('active');
      micBtn.textContent = '🔇';
      if (!webrtcInitialized) {
        setupWebRTCListeners();
        webrtcInitialized = true;
      }
      // Mevcut kullanıcılarla bağlantı kur
      socket.emit('getRoomUsers', (userIds) => {
        userIds.forEach(id => {
          if (id !== socket.id && !peers.has(id)) offerConnection(id);
        });
      });
    } catch (err) {
      alert('Mikrofon izni alınamadı.');
    }
  } else {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    micActive = false;
    micBtn.classList.remove('active');
    micBtn.textContent = '🎤';
    peers.forEach(pc => pc.close());
    peers.clear();
  }
}

function setupWebRTCListeners() {
  socket.on('webrtc_offer', async ({ from, offer }) => {
    const pc = createPeerConnection(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc_answer', { to: from, answer });
  });

  socket.on('webrtc_answer', ({ from, answer }) => {
    const pc = peers.get(from);
    if (pc) pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('webrtc_ice_candidate', ({ from, candidate }) => {
    const pc = peers.get(from);
    if (pc) pc.addIceCandidate(new RTCIceCandidate(candidate));
  });
}

function createPeerConnection(partnerId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('webrtc_ice_candidate', { to: partnerId, candidate });
  };
  pc.ontrack = (event) => {
    const audio = new Audio();
    audio.srcObject = event.streams[0];
    audio.play();
  };
  peers.set(partnerId, pc);
  return pc;
}

async function offerConnection(partnerId) {
  const pc = createPeerConnection(partnerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc_offer', { to: partnerId, offer });
}

// ------------------- VİDEO SENKRONİZASYON -------------------
function bindVideoEvents() {
  // Senkronizasyon sinyalleri (izleyici)
  socket.on('syncPlay', (data) => {
    if (!isAdmin) {
      playVideo();
      if (data.time) seekVideo(data.time);
    }
  });
  socket.on('syncPause', (data) => {
    if (!isAdmin) {
      pauseVideo();
      if (data.time) seekVideo(data.time);
    }
  });
  socket.on('syncSeek', (data) => {
    if (!isAdmin) seekVideo(data.time);
  });

  // Admin kontrolleri
  playPauseBtn.addEventListener('click', () => {
    if (!isAdmin) return;
    if (getPlayerState().isPlaying) {
      pauseVideo();
      socket.emit('pause');
    } else {
      playVideo();
      socket.emit('play');
    }
  });

  seekBar.addEventListener('input', () => {
    if (!isAdmin) return;
    const time = parseFloat(seekBar.value);
    seekVideo(time);
    socket.emit('seek', { time });
  });

  addBtn.addEventListener('click', () => {
    const url = videoLinkInput.value.trim();
    if (!url) return;
    socket.emit('addToPlaylist', { url });
    videoLinkInput.value = '';
  });

  // Hata mesajları
  socket.on('error', ({ message }) => alert(message));
}

// Oynatıcı durumu
function getPlayerState() {
  if (videoType === 'youtube' && player?.getCurrentTime) {
    try {
      const time = player.getCurrentTime();
      const state = player.getPlayerState();
      const isPlaying = (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING);
      return { currentTime: time, isPlaying };
    } catch (e) {}
  } else if (videoType === 'direct' && player) {
    return { currentTime: player.currentTime, isPlaying: !player.paused };
  }
  return { currentTime: 0, isPlaying: false };
}

function playVideo() {
  if (videoType === 'youtube' && player) player.playVideo();
  else if (videoType === 'direct' && player) player.play();
  if (isAdmin) startHeartbeat();
}

function pauseVideo() {
  if (videoType === 'youtube' && player) player.pauseVideo();
  else if (videoType === 'direct' && player) player.pause();
}

function seekVideo(time) {
  if (videoType === 'youtube' && player) player.seekTo(time, true);
  else if (videoType === 'direct' && player) player.currentTime = time;
}

function loadVideo(video, autoplay = false) {
  if (!video) return;
  // Önceki oynatıcıyı temizle
  if (player) {
    if (videoType === 'youtube' && player.destroy) player.destroy();
    else if (videoType === 'direct' && player) player.remove();
    player = null;
    videoContainer.innerHTML = '';
  }

  currentVideo = video;
  videoType = video.type;

  if (videoType === 'youtube') {
    ytReady.then(() => {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${video.id}?enablejsapi=1&autoplay=0&controls=0&modestbranding=1&rel=0&origin=${window.location.origin}`;
      iframe.allow = 'autoplay; encrypted-media';
      videoContainer.appendChild(iframe);

      player = new YT.Player(iframe, {
        events: {
          onReady: () => {
            updateTimeDisplay();
            if (autoplay) playVideo();
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) onVideoEnded();
            updateTimeDisplay();
          }
        }
      });
    });
  } else if (videoType === 'direct') {
    const videoEl = document.createElement('video');
    videoEl.src = video.url;
    videoEl.controls = false;
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.autoplay = autoplay;
    videoEl.crossOrigin = 'anonymous';
    videoContainer.appendChild(videoEl);
    player = videoEl;
    videoEl.addEventListener('ended', onVideoEnded);
    videoEl.addEventListener('timeupdate', updateTimeDisplay);
    if (autoplay) videoEl.play().catch(() => {});
  }

  if (isAdmin) startHeartbeat();
}

function onVideoEnded() {
  if (isAdmin) socket.emit('videoEnded');
}

function updateTimeDisplay() {
  let currentTime = 0, duration = 0;
  try {
    if (videoType === 'youtube' && player?.getCurrentTime) {
      currentTime = player.getCurrentTime();
      duration = player.getDuration();
    } else if (videoType === 'direct' && player) {
      currentTime = player.currentTime;
      duration = player.duration || 0;
    }
  } catch (e) { return; }

  if (!isNaN(currentTime) && !isNaN(duration)) {
    seekBar.max = duration;
    seekBar.value = currentTime;
    timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function startHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (!isAdmin || !socket || !currentVideo) return;
    const state = getPlayerState();
    socket.emit('adminUpdate', state);
  }, 1000);
}

function updatePlaylist(playlist, currentIndex) {
  if (playlist) {
    playlistUl.innerHTML = '';
    playlist.forEach((item, idx) => {
      const li = document.createElement('li');
      li.textContent = item.title;
      if (idx === currentIndex) li.style.color = 'var(--accent)';
      playlistUl.appendChild(li);
    });
  }
}

window.addEventListener('beforeunload', () => {
  if (socket) socket.disconnect();
});