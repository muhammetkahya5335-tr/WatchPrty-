// Socket ve oyuncu durumları
let socket;
let isAdmin = false;
let currentRoom, username;
let player = null;          // YouTube oynatıcı veya HTML5 video elementi
let videoType = null;       // 'youtube' veya 'direct'
let currentVideo = null;
let heartbeatInterval;      // Admin durum gönderimi için sayaç

// DOM elementleri
const joinScreen = document.getElementById('joinScreen');
const appDiv = document.getElementById('app');
const roomInput = document.getElementById('roomInput');
const usernameInput = document.getElementById('usernameInput');
const joinBtn = document.getElementById('joinBtn');
const controls = document.getElementById('controls');
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const timeDisplay = document.getElementById('timeDisplay');
const playlistUl = document.getElementById('playlist');
const adminPanel = document.getElementById('adminPanel');
const videoLinkInput = document.getElementById('videoLinkInput');
const addBtn = document.getElementById('addBtn');
const videoContainer = document.getElementById('videoContainer');

// YouTube API yüklendiğinde çözülecek promise
const ytReadyPromise = new Promise(resolve => {
  window.onYouTubeIframeAPIReady = resolve;
});

// ------------------- Odaya Katılma -------------------
joinBtn.addEventListener('click', () => {
  const roomId = roomInput.value.trim();
  const name = usernameInput.value.trim();
  if (!roomId || !name) return alert('Lütfen oda adı ve kullanıcı adı girin.');

  currentRoom = roomId;
  username = name;
  socket = io();

  // Sunucudan gelen rol ataması
  socket.on('role', (data) => {
    isAdmin = data.isAdmin;
    adminPanel.style.display = isAdmin ? 'flex' : 'none';
    controls.classList.toggle('active', isAdmin);
    joinScreen.style.display = 'none';
    appDiv.style.display = 'flex';
  });

  // Tam oda durumu (yeni katılım veya güncelleme)
  socket.on('roomState', (state) => {
    updatePlaylist(state.playlist, state.currentIndex);
    if (state.currentVideo) {
      loadVideo(state.currentVideo, false);
      // Zaman ve oynatma durumunu eşitle
      if (state.currentVideo.time) seekVideo(state.currentVideo.time);
      if (state.currentVideo.isPlaying) playVideo();
      else pauseVideo();
    }
  });

  // Yeni video yükleme komutu (admin eklediğinde veya video bittiğinde)
  socket.on('loadVideo', (data) => {
    const { video, index } = data;
    updatePlaylist(null, index);
    loadVideo(video, true); // Otomatik oynat
  });

  // Sadece liste güncellemesi
  socket.on('playlistUpdate', (data) => updatePlaylist(data.playlist));

  // Admin olmayan istemciler için senkronizasyon sinyalleri
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

  socket.on('playlistEnded', () => alert('Oynatma listesi sona erdi.'));
  socket.on('error', (data) => alert(data.message));

  socket.emit('joinRoom', { roomId, username });
});

// ------------------- Oyuncu Yönetimi -------------------

// Oynatıcı durumunu al (zaman ve oynuyor mu)
function getPlayerState() {
  if (videoType === 'youtube' && player?.getCurrentTime) {
    try {
      const time = player.getCurrentTime();
      const state = player.getPlayerState();
      const isPlaying = (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING);
      return { currentTime: time, isPlaying };
    } catch (e) { /* API henüz hazır değil */ }
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

// Videoyu yükle ve eski oynatıcıyı temizle
function loadVideo(video, autoplay = false) {
  if (!video) return;

  // Mevcut oynatıcıyı durdur ve kaldır
  if (player) {
    if (videoType === 'youtube' && player.destroy) player.destroy();
    else if (videoType === 'direct' && player) player.remove();
    player = null;
    videoContainer.innerHTML = '';
  }

  currentVideo = video;
  videoType = video.type;

  if (videoType === 'youtube') {
    // YouTube oynatıcıyı oluştur
    ytReadyPromise.then(() => {
      const videoId = video.id;
      const iframe = document.createElement('iframe');
      iframe.id = 'ytplayer';
      iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=${autoplay ? 1 : 0}&controls=0&modestbranding=1&rel=0&origin=${window.location.origin}`;
      iframe.allow = 'autoplay; encrypted-media';
      iframe.setAttribute('frameborder', '0');
      videoContainer.appendChild(iframe);

      player = new YT.Player('ytplayer', {
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange
        }
      });
    });
  } else if (videoType === 'direct') {
    // Doğrudan video elementi
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

// YouTube oynatıcı hazır olduğunda
function onPlayerReady(event) {
  player = event.target;
  updateTimeDisplay();
}

// YouTube durum değişikliği (özellikle bitiş)
function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED) onVideoEnded();
  updateTimeDisplay();
}

// Video bittiğinde admin sunucuya bildirir
function onVideoEnded() {
  if (isAdmin) socket.emit('videoEnded');
}

// Zaman göstergesini güncelle
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

// ------------------- Admin Kalp Atışı -------------------
function startHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (!isAdmin || !socket || !currentVideo) return;
    const state = getPlayerState();
    socket.emit('adminUpdate', state);
  }, 1000);
}

// ------------------- Admin Kontrolleri -------------------
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

// ------------------- Oynatma Listesi Arayüzü -------------------
function updatePlaylist(playlist, currentIndex) {
  if (playlist) {
    playlistUl.innerHTML = '';
    playlist.forEach((item, idx) => {
      const li = document.createElement('li');
      li.textContent = item.title;
      if (idx === currentIndex) li.classList.add('current');
      playlistUl.appendChild(li);
    });
  }
  if (currentIndex !== undefined) {
    [...playlistUl.children].forEach((li, idx) =>
      li.classList.toggle('current', idx === currentIndex)
    );
  }
}

window.addEventListener('beforeunload', () => {
  if (socket) socket.disconnect();
});
