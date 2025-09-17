/**
 * Miraa Clone – Backend (+ Firebase Auth optional)
 * Thứ tự lấy transcript:
 * 1) youtube-transcript (thuần JS, nhanh nhất)
 * 2) ytdl-core captionTracks (fmt=vtt / fmt=srv3)
 * 3) Whisper (OpenAI) từ audio tải bằng ytdl-core (không bắt buộc yt-dlp)
 * Có yt-dlp thì dùng thêm nhưng không phụ thuộc.
 */

// Ưu tiên IPv4 để tránh lỗi mạng/IPv6 trên shared host
require('node:dns').setDefaultResultOrder('ipv4first');

require('dotenv').config();

const os = require('os');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// yt-dlp: tùy chọn
let ytdlp = null;
try {
  if (process.env.USE_YTDLP === '1') {
    ytdlp = require('yt-dlp-exec');
  }
} catch {
  console.warn('ℹ️ yt-dlp-exec không khả dụng (shared hosting).');
}

const ytdl = require('@distube/ytdl-core');
const { transcript } = require('youtube-transcript');
const { OpenAI } = require('openai');

// ================= Firebase Admin (OPTIONAL) =================
const admin = require('firebase-admin');

function initFirebaseAdminFromEnv() {
  try {
    if (admin.apps.length) return;
    const raw =
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
        ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
        : null);
    if (!raw) {
      console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT(_BASE64) chưa cấu hình – API chạy không bắt buộc đăng nhập (trừ khi REQUIRE_AUTH=1).');
      return;
    }
    const creds = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    console.log('✅ Firebase Admin đã khởi tạo.');
  } catch (e) {
    console.error('❌ Lỗi khởi tạo Firebase Admin:', e);
  }
}
initFirebaseAdminFromEnv();

const REQUIRE_AUTH = process.env.REQUIRE_AUTH === '1';
async function maybeRequireAuth(req, res, next) {
  if (!REQUIRE_AUTH) return next();
  if (!admin.apps.length) {
    return res.status(500).json({ error: 'Auth required nhưng Firebase Admin chưa cấu hình' });
  }
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthenticated' });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = decoded; // uid, email...
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ================== App ==================
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
// Cache tĩnh lâu cho assets
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true }));

const hasKey = !!process.env.OPENAI_API_KEY;
if (!hasKey) console.warn('⚠️ OPENAI_API_KEY chưa thiết lập – Whisper sẽ không chạy.');

const openai = hasKey
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 180_000, // 180s cho Whisper
    })
  : null;

const isYouTubeId = (x) => /^[a-zA-Z0-9_-]{11}$/.test(x || '');
const asWatchUrl  = (idOrUrl) => (isYouTubeId(idOrUrl) ? `https://www.youtube.com/watch?v=${idOrUrl}` : idOrUrl);

/* ---------------- Caption (API) ---------------- */
async function fetchCaptionsByApi(idOrUrl) {
  const id = isYouTubeId(idOrUrl) ? idOrUrl : new URL(idOrUrl).searchParams.get('v');
  if (!id) throw new Error('Không nhận diện được videoId');
  const raw = await transcript(id); // [{text, duration, offset}]
  if (!raw?.length) throw new Error('Video không có caption công khai (youtube-transcript).');
  return raw.map(x => ({
    start: Math.max(0, Number(x.offset) || 0),
    end  : Math.max(0.01, (Number(x.offset) || 0) + (Number(x.duration) || 2)),
    text : String(x.text || '').trim()
  })).filter(s => s.text);
}

/* ---------------- Caption (ytdl-core: vtt/srv3) ---------------- */
async function fetchCaptionsViaYtdlCore(idOrUrl) {
  const url = asWatchUrl(idOrUrl);

  const info = await ytdl.getInfo(url, {
    requestOptions: {
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'en-US,en;q=0.8',
      }
    }
  });

  const pr = info?.player_response || info?.playerResponse || {};
  const tracks =
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
    pr?.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.captionTracks ||
    [];

  if (!tracks.length) throw new Error('Không có captionTracks (ytdl-core).');

  const prefer = ['ja','ja-JP','en','en-US','vi','zh-Hans','zh-Hant','ko'];
  let pick = tracks.find(t => prefer.includes(t.languageCode)) || tracks[0];
  if (!pick && tracks.some(t => t.kind === 'asr')) pick = tracks.find(t => t.kind === 'asr');
  if (!pick?.baseUrl) throw new Error('caption track không hợp lệ');

  const getText = async (url) => {
    const r = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'en-US,en;q=0.8'
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} khi tải caption track`);
    return r.text();
  };

  // 1) VTT
  const vttUrl = pick.baseUrl.includes('fmt=') ? pick.baseUrl : `${pick.baseUrl}&fmt=vtt`;
  let vtt = '';
  try { vtt = await getText(vttUrl); } catch {}
  if (vtt && vtt.includes('WEBVTT')) return parseVttStringToSegments(vtt);

  // 2) SRV3 JSON
  const jsonUrl = pick.baseUrl.includes('fmt=')
    ? pick.baseUrl.replace(/fmt=[^&]+/, 'fmt=srv3')
    : `${pick.baseUrl}&fmt=srv3`;

  const jsonTxt = await getText(jsonUrl);
  let j;
  try { j = JSON.parse(jsonTxt); }
  catch { throw new Error('Không parse được srv3 JSON'); }

  if (!j?.events?.length) throw new Error('srv3 không có events');

  const segs = j.events.map(ev => {
    const text = (ev.segs || []).map(s => s.utf8).join('').replace(/\n+/g, ' ').trim();
    if (!text) return null;
    const start = Math.max(0, (Number(ev.tStartMs) || 0) / 1000);
    const end   = Math.max(start + 0.01, start + (Number(ev.dDurationMs) || 2000) / 1000);
    return { start, end, text };
  }).filter(Boolean);

  return mergeShort(segs);
}

function parseVttStringToSegments(text) {
  const norm  = text.replace(/\r/g, '')
                    .replace(/(\d{1,2}:\d{2}:\d{2}|(?:\d{1,2}:)?\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  const lines = norm.split('\n');
  const timeRe = /(?:(\d{1,2}):)?(\d{2}):(\d{2}\.\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2}\.\d{3})/;
  const toSec  = (h,m,s) => Number(h||0)*3600 + Number(m)*60 + Number(s);

  const segs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(timeRe);
    if (m) {
      if (cur && cur.text.trim()) segs.push(cur);
      cur = { start: toSec(m[1],m[2],m[3]), end: toSec(m[4],m[5],m[6]), text: '' };
      continue;
    }
    if (!line.trim()) {
      if (cur && cur.text.trim()) {
        if (cur.end <= cur.start) cur.end = cur.start + 0.2;
        segs.push(cur);
      }
      cur = null; continue;
    }
    if (cur) {
      const clean = line.replace(/<\/?[^>]+>/g, '').trim();
      if (clean) cur.text += (cur.text ? ' ' : '') + clean;
    }
  }
  if (cur && cur.text.trim()) {
    if (cur.end <= cur.start) cur.end = cur.start + 0.2;
    segs.push(cur);
  }
  return mergeShort(segs);
}

function mergeShort(segs) {
  const merged = [];
  for (const seg of segs) {
    const last = merged[merged.length-1];
    if (last && seg.start - last.end < 0.15 && (seg.text.length < 4 || last.text.length < 4)) {
      last.end  = Math.max(last.end, seg.end);
      last.text = (last.text + ' ' + seg.text).trim();
    } else merged.push(seg);
  }
  return merged;
}

/* ---------------- yt-dlp helpers (nếu có) ---------------- */
async function tryFetchYouTubeCaptions(idOrUrl, outNoExt, preferLangs = ['ja','zh-Hans','zh-Hant','ko','en','auto']) {
  if (!ytdlp) throw new Error('yt-dlp không khả dụng');
  const url = asWatchUrl(idOrUrl);
  try { await ytdlp(url, { listSubs: true }); } catch {}
  const langs = preferLangs.filter(l => l !== 'auto').join(',');
  try {
    await ytdlp(url, { skipDownload:true, writeSub:true, writeAutoSub:true, subLang: langs || undefined, subFormat:'vtt', output: outNoExt });
  } catch (e) { console.warn('yt-dlp sub returned non-zero:', e.message); }
  const dir = path.dirname(outNoExt);
  const base = path.basename(outNoExt);
  const vtts = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.vtt'));
  const srts = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.srt'));
  if (!vtts.length && !srts.length) throw new Error('Không thấy file caption (.vtt/.srt)');
  const pickFrom = (arr) => {
    const pref = ['ja','zh-Hans','zh-Hant','ko','en'];
    for (const p of pref) { const hit = arr.find(f => new RegExp(`\\.${p}\\.`, 'i').test(f)); if (hit) return hit; }
    return arr[0];
  };
  const pick = vtts.length ? pickFrom(vtts) : pickFrom(srts);
  return path.join(dir, pick);
}

/* ---------------- Audio download (ytdl-core) ---------------- */
async function downloadAudioBest(idOrUrl, outNoExt) {
  const url = asWatchUrl(idOrUrl);
  const outPath = `${outNoExt}.m4a`;
  const ITAG = Number(process.env.AUDIO_ITAG || 139); // 139=48kbps, 140=128kbps

  await new Promise((resolve, reject) => {
    ytdl(url, {
      quality: ITAG,
      filter: 'audioonly',
      highWaterMark: 1 << 25,
      requestOptions: {
        headers: {
          'user-agent': 'Mozilla/5.0',
          'accept-language': 'en-US,en;q=0.8'
        }
      }
    })
    .on('error', reject)
    .pipe(fs.createWriteStream(outPath))
    .on('error', reject)
    .on('finish', resolve);
  });

  const stat = fs.statSync(outPath);
  if (stat.size < 10 * 1024) throw new Error('Audio size quá nhỏ, tải lỗi?');
  return outPath;
}

/* ---------------- Whisper ---------------- */
async function whisperSegments(filePath) {
  if (!openai) throw new Error('OPENAI_API_KEY missing.');
  try {
    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'verbose_json'
    });
    if (!resp) throw new Error('Whisper không trả kết quả');
    if (!resp.segments?.length) {
      const text = resp.text || '';
      const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
      return parts.map((p, i) => ({ start: i*5, end: i*5+5, text: p }));
    }
    return resp.segments.map(s => ({
      start: Math.max(0, Number(s.start) || 0),
      end  : Math.max(0.01, Number(s.end)  || (Number(s.start)+3) || 3),
      text : (s.text || '').trim()
    })).filter(x => x.text);
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const data   = e?.response?.data || e?.message || String(e);
    throw new Error(`OpenAI Whisper request failed (status=${status}): ${data}`);
  }
}

/* ---------------- Translate & Romaji ---------------- */
async function translateBatchToVi(sentences) {
  if (!sentences.length) return [];
  if (!openai) throw new Error('Connection error.');
  const prompt =
`Bạn là dịch giả. Dịch TỪNG câu sau sang TIẾNG VIỆT tự nhiên, rõ ràng.
Chỉ trả về MẢNG JSON các chuỗi, không giải thích thêm.
Nếu đầu vào đã là tiếng Việt thì giữ nguyên.

Số câu: ${sentences.length}
${sentences.map((s,i)=>`${i+1}. ${s}`).join('\n')}

TRẢ VỀ:
["...","...", ...]`;
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Bạn là trợ lý dịch thuật chính xác.' },
      { role: 'user', content: prompt }
    ]
  });
  const out = r.choices?.[0]?.message?.content?.trim() || '[]';
  try { const arr = JSON.parse(out); return Array.isArray(arr) ? arr.map(x => String(x||'')) : sentences.map(()=> ''); }
  catch { return sentences.map(()=> ''); }
}

async function jaToRomajiBatch(sentences = []) {
  if (!sentences.length) return [];
  if (!openai) return sentences.map(() => '');
  const prompt =
`Chuyển TỪNG câu tiếng Nhật sau sang ROMAJI (Hepburn). Đọc đầy đủ cả kanji.
- Chỉ trả về MẢNG JSON các chuỗi, số phần tử đúng bằng số câu.
- Không kèm giải thích/phiên âm kana/phi chú.

Ví dụ:
入力: ["北野です。","失礼ですが、どなたですか？"]
出力: ["Kitano desu.","Shitsurei desu ga, donata desu ka?"]

Số câu: ${sentences.length}
${sentences.map((s,i)=>`${i+1}. ${s}`).join('\n')}

TRẢ VỀ:
["...","...", ...]`;
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'Bạn là bộ máy phiên âm tiếng Nhật sang romaji (Hepburn) chính xác.' },
      { role: 'user', content: prompt }
    ]
  });
  const out = r.choices?.[0]?.message?.content?.trim() || '[]';
  try { const arr = JSON.parse(out); return Array.isArray(arr) ? arr.map(x => String(x||'')) : sentences.map(()=> ''); }
  catch { return sentences.map(()=> ''); }
}

/* ---------------- API ---------------- */
app.get('/api/transcript', maybeRequireAuth, async (req, res) => {
  const raw = String(req.query.url || '').trim();
  const skipTranslate = String(req.query.skipTranslate || '0') === '1';
  if (!raw) return res.status(400).json({ error: 'Missing url' });

  let videoId = null;
  if (isYouTubeId(raw)) videoId = raw;
  else {
    try { const u = new URL(raw); videoId = u.searchParams.get('v'); }
    catch { return res.status(400).json({ error: 'URL YouTube không hợp lệ' }); }
  }
  if (!videoId) return res.status(400).json({ error: 'Không tìm thấy videoId trong URL' });

  // Ghi file tạm vào thư mục hệ thống (Render cho phép ghi /tmp)
  const tmpPrefix = path.join(os.tmpdir(), `miraa_${uuidv4()}`);

  try {
    console.log('🔎 Lấy captions…');
    let segments = [];

    // 1) youtube-transcript
    try {
      segments = await fetchCaptionsByApi(videoId);
      console.log('✔️ Captions qua API:', segments.length);
    } catch (eApi) {
      console.warn('API caption lỗi:', eApi.message);

      // 2) ytdl-core (vtt/srv3)
      try {
        segments = await fetchCaptionsViaYtdlCore(videoId);
        console.log('✔️ Captions qua ytdl-core:', segments.length);
      } catch (eCore) {
        console.warn('ytdl-core caption lỗi:', eCore.message);

        // 3) Nếu có yt-dlp, thử nốt
        if (ytdlp) {
          try {
            const capPath = await tryFetchYouTubeCaptions(videoId, tmpPrefix,
              ['ja','zh-Hans','zh-Hant','ko','en','auto']);
            console.log('✔️ Captions file:', path.basename(capPath));
            const vtt = fs.readFileSync(capPath, 'utf8');
            segments = parseVttStringToSegments(vtt);
          } catch (eY) {
            console.warn('yt-dlp caption lỗi:', eY.message);
          }
        }

        // 4) Cuối cùng: Whisper (bắt buộc fallback, không phụ thuộc yt-dlp)
        if (!segments.length) {
          try {
            const audioPath = await downloadAudioBest(videoId, tmpPrefix);
            segments = await whisperSegments(audioPath);
            console.log('✔️ Whisper fallback:', segments.length);
          } catch (eW) {
            console.error('❌ Whisper fallback lỗi:', eW.message);
            return res.status(502).json({
              error: 'Không lấy được caption (API/ytdl-core/Whisper đều lỗi).',
              details: eW.message
            });
          }
        }
      }
    }

    // ROMAJI
    let romajis = [];
    try {
      const MAXR = 40;
      for (let i = 0; i < segments.length; i += MAXR) {
        const batch = segments.slice(i, i + MAXR).map(s => s.text);
        const r = await jaToRomajiBatch(batch);
        romajis.push(...r);
      }
    } catch (e) {
      console.warn('Romaji AI lỗi:', e.message);
      romajis = segments.map(() => '');
    }

    // DỊCH
    let translations = [];
    if (!skipTranslate) {
      try {
        const MAXT = 30;
        for (let i = 0; i < segments.length; i += MAXT) {
          const batch = segments.slice(i, i + MAXT).map(s => s.text);
          const vi = await translateBatchToVi(batch);
          translations.push(...vi);
        }
      } catch (e) {
        console.warn('Dịch lỗi, trả nguyên văn:', e.message);
        translations = segments.map(s => s.text);
      }
    } else {
      translations = segments.map(() => '');
    }

    const result = segments.map((s, i) => ({
      start : s.start,
      end   : s.end,
      text  : s.text,
      romaji: romajis[i] || '',
      vn    : translations[i] ?? ''
    }));
    return res.json(result);

  } catch (err) {
    console.error('[ERROR /api/transcript]', err?.response?.data || err?.message || err);
    return res.status(500).json({
      error: 'Transcription failed',
      details: String(err?.response?.data || err?.message || err)
    });
  } finally {
    // cleanup tmp*
    try {
      const base = path.basename(tmpPrefix);
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith(base)) {
          try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {}
        }
      }
    } catch {}
  }
});

/* ---------------- static & health ---------------- */
app.get('/health', (req, res) => res.json({ ok: true, hasKey }));
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server chạy: http://localhost:${PORT}`);
  console.log(`GET /api/transcript?url=<youtube_link_or_id>[&skipTranslate=1]`);
});

/* ---------------- OpenAI diag ---------------- */
app.get('/diag/openai', async (req, res) => {
  if (!openai) return res.status(400).json({ ok: false, reason: 'OPENAI_API_KEY missing' });
  try {
    const r = await openai.models.list({});
    res.json({ ok: true, count: (r?.data?.length ?? 0) });
  } catch (e) {
    res.status(502).json({
      ok: false,
      status: e?.status || e?.response?.status,
      name: e?.name,
      message: e?.message,
      data: e?.response?.data
    });
  }
});
