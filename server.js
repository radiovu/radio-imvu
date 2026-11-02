const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Fila única compartilhada (em memória)
let queue = [];     // {id, videoId, title, thumb, addedBy}
let nextId = 1;
let current = 0;    // índice da música tocando
let silent = false;

const YT_KEY = process.env.YOUTUBE_API_KEY || '';

function extractVideoId(text) {
  const m = text.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function searchYouTube(q) {
  if (!YT_KEY) throw new Error('Falta a variável YOUTUBE_API_KEY no servidor.');
  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q='
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

app.get('/radio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'radio.html')));

app.get('/api/search', async (req, res) => {
  try { res.json(await searchYouTube(req.query.q || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/queue', (req, res) => res.json({ queue, current, silent }));

app.post('/api/add', async (req, res) => {
  try {
    const addedBy = (req.body.addedBy || 'Anônimo').slice(0, 30);
    let { videoId, title, thumb, text } = req.body;
    if (!videoId && text) {
      // comando ADD: aceita link ou nome da música
      text = text.replace(/^add\s+/i, '').t
