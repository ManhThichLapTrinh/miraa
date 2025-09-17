/* ====== Video trên / Phụ đề dưới – romaji server + fallback client, loading, auto-scroll + Firebase Auth ====== */

/** ĐỔI URL này sang domain backend thật của bạn */
const API_BASE = 'https://miraa-b32l.onrender.com';

let player = null;
let transcript = [];
let pendingVideoId = null;
let activeIndex = -1;
let pollTimer = null;

/* ---------------- Firebase Auth (tùy chọn) ----------------
   - index.html cần nhúng SDK và gắn window.__FIREBASE__ (auth, provider, onAuthStateChanged, signInWithPopup, signOut)
   - Nếu không có, khối này tự bỏ qua, app vẫn hoạt động bình thường.
---------------------------------------------------------------- */
const FB = window.__FIREBASE__ || {};
let currentIdToken = null;

const elIn  = document.getElementById('btnSignIn');
const elOut = document.getElementById('btnSignOut');
const elWho = document.getElementById('who');

if (FB && FB.auth && FB.onAuthStateChanged) {
  // Gắn nút (nếu tồn tại trong DOM)
  elIn?.addEventListener('click', async () => {
    try { await FB.signInWithPopup(FB.auth, FB.provider); } catch (e) { console.error(e); }
  });
  elOut?.addEventListener('click', async () => {
    try { await FB.signOut(FB.auth); } catch (e) { console.error(e); }
  });

  FB.onAuthStateChanged(FB.auth, async (user) => {
    try {
      if (user) {
        elIn && (elIn.style.display = 'none');
        elOut && (elOut.style.display = '');
        if (elWho) elWho.textContent = `Xin chào, ${user.displayName || user.email || user.uid}`;
        currentIdToken = await user.getIdToken(true);
      } else {
        elIn && (elIn.style.display = '');
        elOut && (elOut.style.display = 'none');
        if (elWho) elWho.textContent = '';
        currentIdToken = null;
      }
    } catch (e) {
      console.error('Auth state error:', e);
      currentIdToken = null;
    }
  });
}

/* ---------------- Helpers ---------------- */
function parseYouTubeId(input) {
  try {
    if (!input) return null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
    const url = new URL(input);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1);
    const v = url.searchParams.get('v'); if (v) return v;
    const m = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/); if (m) return m[1];
  } catch { if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input; }
  return null;
}
function hasJapanese(str=''){ return /[\u3040-\u30ff\u3400-\u9fff]/.test(str); }
function toRomajiClient(str=''){
  if (!window.wanakana || typeof wanakana.toRomaji !== 'function') return '';
  try { return hasJapanese(str) ? wanakana.toRomaji(str) : ''; } catch { return ''; }
}

/* ---------------- Render 3 dòng ---------------- */
function renderTranscript(list) {
  const wrap = document.getElementById('subsList');
  wrap.innerHTML = '';
  activeIndex = -1;

  list.forEach((t, i) => {
    const romaji = (t.romaji && String(t.romaji).trim()) || toRomajiClient(t.text || '');

    const el = document.createElement('div');
    el.className = 'line';
    el.id = 'line-' + i;
    el.innerHTML = `
      <div class="jp">${t.text || ''}</div>
      <div class="romaji">${romaji}</div>
      <div class="vi">${t.vn || ''}</div>
    `;
    el.addEventListener('click', () => {
      try { player?.seekTo?.(t.start, true); player?.playVideo?.(); } catch {}
    });
    wrap.appendChild(el);
  });
}

/* ---------- tìm câu hiện tại (binary search) ---------- */
function findActiveIndex(current) {
  let lo=0, hi=transcript.length-1, ans=-1;
  while (lo<=hi) {
    const mid=(lo+hi)>>1;
    const {start,end}=transcript[mid];
    if (current < start) hi=mid-1;
    else if (current >= end) lo=mid+1;
    else { ans=mid; break; }
  }
  return ans;
}

/* ---------------- Polling highlight ---------------- */
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!player) return;

    let cur=0;
    try { cur = player.getCurrentTime ? player.getCurrentTime() : 0; } catch {}

    if (transcript.length) {
      const idx = findActiveIndex(cur);
      if (idx !== activeIndex) {
        if (activeIndex >= 0) {
          const old = document.getElementById('line-'+activeIndex);
          old && old.classList.remove('active');
        }
        activeIndex = idx;
        if (activeIndex >= 0) {
          const el = document.getElementById('line-'+activeIndex);
          if (el) {
            el.classList.add('active');
            el.scrollIntoView({ block:'center', behavior:'smooth' });
          }
        }
      }
    }
  }, 200);
}

/* ---------------- YT Iframe API ---------------- */
function onPlayerReady() {
  startPolling();
  if (pendingVideoId) {
    try { player.cueVideoById(pendingVideoId); player.playVideo(); pendingVideoId=null; } catch {}
  }
}
function onPlayerStateChange(){ startPolling(); }
function onYouTubeIframeAPIReady() {
  player = new YT.Player('ytplayer', {
    events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

/* ---------------- Loading overlay ---------------- */
function setLoading(v) {
  const overlay = document.getElementById('loadingOverlay');
  overlay.classList.toggle('hidden', !v);
}

/* ---------------- Submit form ---------------- */
document.getElementById('urlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = document.getElementById('youtubeUrl').value.trim();
  const videoId = parseYouTubeId(raw);
  if (!videoId) { alert('Không nhận diện được videoId từ link YouTube!'); return; }

  const iframe = document.getElementById('ytplayer');
  const embed = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${location.origin}`;
  if (iframe.src !== embed) iframe.src = embed;

  if (player && typeof player.loadVideoById === 'function') {
    try { player.loadVideoById(videoId); } catch {}
  } else {
    pendingVideoId = videoId;
  }

  const urlApi = `${API_BASE}/api/transcript?url=${encodeURIComponent(raw)}`;
  try {
    setLoading(true);

    // === Gửi kèm Firebase ID token nếu có ===
    const headers = currentIdToken ? { 'Authorization': `Bearer ${currentIdToken}` } : {};

    const res = await fetch(urlApi, { headers });
    const txt = await res.text();
    setLoading(false);

    if (!res.ok) {
      let msg = `API trả lỗi ${res.status}`;
      try { const j = JSON.parse(txt); if (j.error || j.details) msg += `\n${j.error || ''}\n${j.details || ''}`; } catch {}
      alert('Không lấy được phụ đề.\n' + msg);
      console.error('API error:', res.status, txt);
      return;
    }

    const data = JSON.parse(txt);
    if (!Array.isArray(data) || !data.length) {
      alert('API trả 0 câu phụ đề.');
      return;
    }

    transcript = data.map((t,i)=>({
      index:i,
      start:Number(t.start) || i*3,
      end  :Number(t.end)   || i*3+3,
      text :(t.text || '').trim(),
      romaji:(t.romaji || '').trim(),
      vn   :(t.vn   || '').trim()
    }));

    renderTranscript(transcript);
    startPolling();
  } catch (err) {
    setLoading(false);
    console.error('Fetch failed:', err);
    alert('Không lấy được phụ đề từ API. Kiểm tra server nhé.');
  }
});
