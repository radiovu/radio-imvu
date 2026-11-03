const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YT_KEY = process.env.YOUTUBE_API_KEY || process.env.YT_KEY;
const YTDLP = path.join(__dirname, 'yt-dlp_linux');

// Estado compartilhado: uma fila unica para todos
const state = { queue: [], current: -1, silent: false };

// ---------- YouTube ----------
async function searchYouTube(q) {
  if (!YT_KEY) throw new Error('Falta a variável YOUTUBE_API_KEY no Render');
  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&videoEmbeddable=true&q='
    + encodeURIComponent(q) + '&key=' + YT_KEY;
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return (data.items || []).map(i => ({
    videoId: i.id.videoId,
    title: i.snippet.title,
    thumb: i.snippet.thumbnails.default.url
  }));
}

async function getVideo(id) {
  if (!YT_KEY) throw new Error('Falta a variável YOUTUBE_API_KEY no Render');
  const url = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id='
    + encodeURIComponent(id) + '&key=' + YT_KEY;
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  const v = (data.items || [])[0];
  if (!v) throw new Error('Vídeo não encontrado');
  return {
    videoId: id,
    title: v.snippet.title,
    thumb: v.snippet.thumbnails.default.url
  };
}

function extractVideoId(text) {
  const m = text.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ---------- Stream MP3 ao vivo ----------
const listeners = new Set();
const streamStatus = { lastError: '', playingTitle: '' };
let silenceBuf = Buffer.alloc(0);
let killCurrent = () => {};
let skipped = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function broadcast(chunk) {
  for (const res of listeners) res.write(chunk);
}

// 1 segundo de silencio em MP3, usado quando nao ha musica tocando
function makeSilence() {
  return new Promise(resolve => {
    const f = spawn(ffmpegPath, ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '1', '-f', 'mp3', '-b:a', '128k', 'pipe:1']);
    const bufs = [];
    f.stdout.on('data', d => bufs.push(d));
    f.on('close', () => resolve(Buffer.concat(bufs)));
    f.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// Toca uma musica: yt-dlp baixa o audio, ffmpeg converte para MP3 em tempo real
function playTrack(track) {
  return new Promise(resolve => {
    let got = 0;
    let err = '';
    const yt = spawn(YTDLP, ['-f', 'bestaudio', '--no-playlist', '-o', '-', '--quiet',
      'https://www.youtube.com/watch?v=' + track.videoId]);
    const ff = spawn(ffmpegPath, ['-re', '-i', 'pipe:0', '-vn', '-f', 'mp3',
      '-b:a', '128k', '-ar', '44100', '-ac', '2', 'pipe:1']);

    yt.stderr.on('data', d => { err += d; });
    ff.stdin.on('error', () => {});
    yt.stdout.pipe(ff.stdin);
    ff.stdout.on('data', d => { got += d.length; broadcast(d); });

    killCurrent = () => {
      try { yt.kill('SIGKILL'); } catch (e) {}
      try { ff.kill('SIGKILL'); } catch (e) {}
    };

    yt.on('error', e => {
      streamStatus.lastError = 'yt-dlp: ' + e.message;
      try { ff.kill('SIGKILL'); } catch (x) {}
    });
    ff.on('error', e => {
      streamStatus.lastError = 'ffmpeg: ' + e.message;
      resolve();
    });
    ff.on('close', () => {
      try { yt.kill('SIGKILL'); } catch (e) {}
      if (!got && !skipped) streamStatus.lastError = (err || 'nenhum áudio recebido').slice(-400);
      resolve();
    });
  });
}

async function streamLoop() {
  silenceBuf = await makeSilence();
  while (true) {
    const track = state.queue[state.current];
    if (track && listeners.size > 0) {
      streamStatus.playingTitle = track.title;
      skipped = false;
      await playTrack(track);
      streamStatus.playingTitle = '';
      if (!skipped) {
        state.current++; // terminou sozinha: vai para a proxima
        await sleep(300);
      }
    } else {
      broadcast(silenceBuf);
      await sleep(1000);
    }
  }
}
streamLoop();

app.get(['/stream', '/stream.mp3'], (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'icy-name': 'Radio IMVU'
  });
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
});

// Para ver o que esta acontecendo com o stream
app.get('/api/stream-status', (req, res) => res.json({
  listeners: listeners.size,
  playing: streamStatus.playingTitle,
  lastError: streamStatus.lastError
}));

// ---------- Paginas ----------
app.get('/radio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'radio.html')));

// ---------- API ----------
app.get('/api/search', async (req, res) => {
  try { res.json(await searchYouTube(req.query.q || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/queue', (req, res) => res.json({
  queue: state.queue,
  current: state.current,
  silent: state.silent
}));

app.post('/api/add', async (req, res) => {
  try {
    const addedBy = (req.body.addedBy || 'Anônimo').slice(0, 30);
    let { videoId, title, thumb, text } = req.body;

    if (!videoId && text) {
      // comando ADD: aceita link ou nome da música
      text = text.replace(/^add\s+/i, '').trim();
      const id = extractVideoId(text);
      if (id) {
        ({ videoId, title, thumb } = await getVideo(id));
      } else {
        const results = await searchYouTube(text);
        if (!results.length) return res.status(404).json({ error: 'Nada encontrado' });
        ({ videoId, title, thumb } = results[0]);
      }
    }

    if (!videoId) return res.status(400).json({ error: 'Faltou a música' });

    state.queue.push({
      id: videoId,
      videoId,
      title: title || videoId,
      thumb: thumb || '',
      addedBy,
      by: addedBy
    });

    // se nada estava tocando, comeca a nova musica
    if (!state.queue[state.current]) state.current = state.queue.length - 1;

    res.json({ ok: true, queue: state.queue, current: state.current });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Controles (aceitam GET ou POST). Cada um corta a musica que esta no stream.
function cutStream() {
  skipped = true;
  killCurrent();
}

app.all('/api/next', (req, res) => {
  state.current = Math.min(state.current + 1, state.queue.length);
  cutStream();
  res.json({ ok: true, current: state.current });
});

app.all('/api/prev', (req, res) => {
  state.current = Math.max(state.current - 1, 0);
  cutStream();
  res.json({ ok: true, current: state.current });
});

app.all('/api/stop', (req, res) => {
  state.current = state.queue.length;
  cutStream();
  res.json({ ok: true });
});

app.all('/api/clear', (req, res) => {
  state.queue = [];
  state.current = -1;
  cutStream();
  res.json({ ok: true });
});

app.all('/api/silent', (req, res) => {
  state.silent = !state.silent;
  res.json({ ok: true, silent: state.silent });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Rádio IMVU rodando na porta ' + PORT));
