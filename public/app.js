// ── State ────────────────────────────────────────────────
let lyrics         = [];       // [{ ms, words }]
let annotated      = [];       // [{ original, translation, tokens }]
let progressMs     = 0;
let lastFetched    = 0;
let currentIndex   = -1;
let currentTrackId = '';
let isPlaying      = false;
let isAnnotated    = false;

// ── DOM refs ─────────────────────────────────────────────
const loginScreen      = document.getElementById('login-screen');
const player           = document.getElementById('player');
const trackNameEl      = document.getElementById('track-name');
const artistNameEl     = document.getElementById('artist-name');
const lyricsContainer  = document.getElementById('lyrics-container');
const lyricsEmpty      = document.getElementById('lyrics-empty');
const statusDot        = document.getElementById('status-dot');
const annotatingLabel  = document.getElementById('annotating-label');
const analysisLoading  = document.getElementById('analysis-loading');
const translationEl    = document.getElementById('translation-text');
const tokenGrid        = document.getElementById('token-grid');

// ── Helpers ───────────────────────────────────────────────
function isJapanese(text) {
  return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
}

// ── LRC parser ───────────────────────────────────────────
function parseLRC(raw) {
  return raw.split('\n')
    .map(line => {
      const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
      if (!match) return null;
      const ms    = (parseFloat(match[1]) * 60 + parseFloat(match[2])) * 1000;
      const words = match[3].trim();
      return { ms, words };
    })
    .filter(line => line !== null && line.words.length > 0);
}

// ── Poll progress — fast, every 3 seconds ─────────────────
async function pollProgress() {
  try {
    const res = await fetch('/progress');

    if (res.status === 204) { setStatus(false); return; }
    if (!res.ok) return;

    const data = await res.json();

    // smart progress — only accept Spotify's value if meaningfully different
    const localNow = progressMs + (Date.now() - lastFetched);
    const diff     = Math.abs(data.progressMs - localNow);

    if (diff > 1500 || data.progressMs > localNow) {
      progressMs  = data.progressMs;
      lastFetched = Date.now();
    }

    isPlaying = data.isPlaying;
    setStatus(data.isPlaying);

    trackNameEl.textContent  = data.trackName;
    artistNameEl.textContent = data.artistName;

    // track changed
    if (data.trackId !== currentTrackId) {
      currentTrackId = data.trackId;
      currentIndex   = -1;
      lyrics         = [];
      annotated      = [];
      isAnnotated    = false;

      // clear right panel
      resetRightPanel();

      // show loading state
      lyricsContainer.innerHTML = '';
      const loading     = document.createElement('div');
      loading.className = 'lyrics-empty';
      loading.innerHTML = '<span>♩</span><p>Loading lyrics…</p>';
      lyricsContainer.appendChild(loading);

      fetchLyrics(data.trackName, data.artistName, data.albumName, data.duration);
    }

  } catch (err) {
    console.error('Progress error:', err);
    setStatus(false);
  }
}

// ── Fetch lyrics — slow, only on track change ─────────────
async function fetchLyrics(trackName, artistName, albumName, duration) {
  try {
    const res = await fetch('/lyrics?' + new URLSearchParams({
      track_name: trackName, artist_name: artistName,
      album_name: albumName, duration
    }));

    if (!res.ok) return;
    const data = await res.json();

    if (data.syncedLyrics) {
      lyrics = parseLRC(data.syncedLyrics);
      renderLyrics();

      // only annotate if lyrics are Japanese
      const sample = lyrics.slice(0, 5).map(l => l.words).join('');
      if (isJapanese(sample)) {
        annotateAllLines(lyrics.map(l => l.words));
      }
    } else {
      lyrics = [];
      lyricsContainer.innerHTML = '';
      lyricsEmpty.querySelector('p').textContent = 'No lyrics found for this track.';
      lyricsContainer.appendChild(lyricsEmpty);
      lyricsEmpty.style.display = 'flex';
    }

  } catch (err) {
    console.error('Lyrics error:', err);
  }
}

// ── Annotate all lines via server ─────────────────────────
async function annotateAllLines(lines) {
  // show loading state
  annotatingLabel.classList.remove('hidden');
  analysisLoading.classList.remove('hidden');

  try {
    const res = await fetch('/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines })
    });

    if (!res.ok) throw new Error('Annotation failed');

    const data = await res.json();
    annotated   = data.annotated; // array of { original, translation, tokens }
    isAnnotated = true;

    // if a line is already active, update right panel immediately
    if (currentIndex >= 0 && annotated[currentIndex]) {
      updateRightPanel(annotated[currentIndex]);
    }

  } catch (err) {
    console.error('Annotation error:', err);
  } finally {
    annotatingLabel.classList.add('hidden');
    analysisLoading.classList.add('hidden');
  }
}

// ── Render lyrics to DOM ──────────────────────────────────
function renderLyrics() {
  lyricsContainer.innerHTML = '';

  if (!lyrics.length) {
    lyricsEmpty.style.display = 'flex';
    lyricsContainer.appendChild(lyricsEmpty);
    return;
  }

  const spacerTop = document.createElement('div');
  spacerTop.style.height = '40vh';
  lyricsContainer.appendChild(spacerTop);

  lyrics.forEach((line, i) => {
    const el         = document.createElement('p');
    el.className     = 'lyric-line';
    el.textContent   = line.words;
    el.dataset.index = i;
    lyricsContainer.appendChild(el);
  });

  const spacerBottom = document.createElement('div');
  spacerBottom.style.height = '40vh';
  lyricsContainer.appendChild(spacerBottom);
}

// ── Sync loop ─────────────────────────────────────────────
function syncLyrics() {
  if (!lyrics.length) return;

  const elapsed = isPlaying ? Date.now() - lastFetched : 0;
  const now     = progressMs + elapsed;
  const index   = lyrics.findLastIndex(line => line.ms <= now);

  if (index !== currentIndex) {
    currentIndex = index;
    highlightLine(index);

    // update right panel if annotation is ready
    if (isAnnotated && annotated[index]) {
      updateRightPanel(annotated[index]);
    }
  }
}

// ── Highlight active lyric line ───────────────────────────
function highlightLine(index) {
  const lines = document.querySelectorAll('.lyric-line');

  lines.forEach((el, i) => {
    el.classList.remove('active', 'near');
    if (i === index)                               el.classList.add('active');
    else if (i === index - 1 || i === index + 1)  el.classList.add('near');
  });

  if (!isPlaying) return;

  const activeEl = lines[index];
  if (activeEl) {
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ── Update right panel ────────────────────────────────────
function updateRightPanel(lineData) {
  if (!lineData) return;

  // translation
  translationEl.textContent = lineData.translation ?? '—';
  translationEl.classList.add('active');

  // token grid
  tokenGrid.innerHTML = '';

  if (!lineData.tokens || !lineData.tokens.length) {
    tokenGrid.innerHTML = '<div class="analysis-placeholder">No breakdown available.</div>';
    return;
  }

  lineData.tokens.forEach(token => {
    const card = document.createElement('div');
    card.className  = 'token';
    card.dataset.pos = token.pos ?? 'other';

    const surface = document.createElement('div');
    surface.className   = 'token-surface';
    surface.textContent = token.surface;

    const reading = document.createElement('div');
    reading.className   = 'token-reading';
    reading.textContent = token.reading ?? '';

    const pos = document.createElement('div');
    pos.className   = 'token-pos';
    pos.textContent = token.pos ?? '';

    card.appendChild(surface);
    card.appendChild(reading);
    card.appendChild(pos);
    tokenGrid.appendChild(card);
  });
}

// ── Reset right panel ─────────────────────────────────────
function resetRightPanel() {
  translationEl.textContent = '—';
  translationEl.classList.remove('active');
  tokenGrid.innerHTML = '<div class="analysis-placeholder">Play a Japanese track to see the breakdown.</div>';
}

// ── Status dot ────────────────────────────────────────────
function setStatus(live) {
  statusDot.classList.toggle('live', live);
}

// ── Entry point ───────────────────────────────────────────
async function init() {
  try {
    const res  = await fetch('/token');
    const data = await res.json();

    if (!data.access_token) {
      loginScreen.classList.remove('hidden');
      player.classList.add('hidden');
      return;
    }

    loginScreen.classList.add('hidden');
    player.classList.remove('hidden');

    await pollProgress();

    setInterval(pollProgress, 3000);
    setInterval(syncLyrics,   50);

  } catch (err) {
    console.error('Init error:', err);
  }
}

init();
