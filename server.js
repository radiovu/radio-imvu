const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YT_KEY = process.env.YOUTUBE_API_KEY || process.env.YT_KEY;

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

// Controles (aceitam GET ou POST)
app.all('/api/next', (req, res) => {
  state.current = Math.min(state.current + 1, state.queue.length);
  res.json({ ok: true, current: state.current });
});

app.all('/api/prev', (req, res) => {
  state.current = Math.max(state.current - 1, 0);
  res.json({ ok: true, current: state.current });
});

app.all('/api/stop', (req, res) => {
  state.current = state.queue.length;
  res.json({ ok: true });
});

app.all('/api/clear', (req, res) => {
  state.queue = [];
  state.current = -1;
  res.json({ ok: true });
});

app.all('/api/silent', (req, res) => {
  state.silent = !state.silent;
  res.json({ ok: true, silent: state.silent });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Rádio IMVU rodando na porta ' + PORT));
