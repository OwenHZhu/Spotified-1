require('dotenv').config({ path: './.env' });

const express = require('express');
const { access } = require('fs');
const app = express();
const querystring = require('querystring');
const request = require('request'); 
const { GoogleGenAI } = require('@google/genai'); // commonJS import, not ES module
const { addAbortListener } = require('events');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

console.log('REDIRECT:', process.env.REDIRECT_URI);
const client_id     = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri  = process.env.REDIRECT_URI;
const port          = process.env.PORT || 8888;
var access_token = null;

const kuromoji = require('kuromoji');

// build once at server startup — takes ~1 second
let tokenizer = null;

kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict' })
  .build((err, built) => {
    if (err) throw err;
    tokenizer = built;
    console.log('Kuromoji ready');
  });

app.use(express.static('public'));

function generateRandomString(length) {
    var result           = '';
    var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for ( var i = 0; i < length; i++ ) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

function parseLRC(lrcText) {
  const lines = lrcText.split('\n');

  return lines
    .map(line => {
      const match = line.match(/\[(\d+):(\d+)(?:\.(\d+))\](.*)/)
      if (!match) return null;

      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2]);
      const decimal = match[3] ? parseFloat("0." + match[3]) : 0;
      const text = match[4].trim();

      return {
        time: minutes * 60000 + seconds * 1000 + decimal * 1000, // total seconds to mss
        text
      };
    })
    .filter(Boolean);
}




app.get('/token', (req, res) => {
  res.json({access_token});
});

app.get('/login', function(req, res) {
  var state = generateRandomString(16);
  var scope = 'user-read-private user-read-email user-read-playback-state';

  res.redirect('https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }).toString());
});


//real callback
app.get('/callback', async function(req, res) {

  var code = req.query.code || null;
  var state = req.query.state || null;

  if (state === null) {
    res.redirect('/#' + new URLSearchParams({ error: 'state_mismatch' }).toString());
  } else {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
      },
      body: new URLSearchParams({
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      })
    });

    const data = await response.json();
    access_token = data.access_token;
    //console.log("Access Token: " + access_token);
    
    res.redirect('/');
  }
});


app.get('/lyrics', async function(req, res) {
  const startTime = performance.now(); //start of api time logger

  const { track_name, artist_name, album_name, duration } = req.query;
  const response = await fetch('https://lrclib.net/api/get?' +
    new URLSearchParams({ track_name, artist_name, album_name, duration })
  );

  console.log( track_name + artist_name +  album_name + duration);

  const data = await response.json();
  res.json({ syncedLyrics: data.syncedLyrics ?? null });
  
  

  //end of api time logger
  const endTime = performance.now();
  const timetTaken = (endTime - startTime);
  console.log("call took " + endTime.toFixed(2) + " - " + startTime.toFixed(2) + " = " +  timetTaken.toFixed(2));


})


app.get('/progress', async function(req, res){
  const response = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + access_token
    }
  });
  if (response.status === 204){
    return res.status(204).send();
    return;
  }
  const data = await response.json();
  if (!data || !data.item) return res.status(204).send();

  res.json({
    trackName:  data.item.name,
    artistName: data.item.artists[0].name,
    albumName:  data.item.album.name,
    duration:   data.item.duration_ms / 1000,
    progressMs: data.progress_ms,
    isPlaying:  data.is_playing,
    trackId:    data.item.id
  });
  console.log("polling progress of: " + data.item.name);
})

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});


app.post('/annotate', express.json(), async function(req, res) {
  const { lines } = req.body;

  const prompt = `You are a Japanese linguistics assistant.
For each line in the JSON array below, return a JSON array of objects with this exact structure:
{
  "original": "original line text",
  "translation": "English translation of the line",
  "tokens": [
    { "surface": "僕", "reading": "ぼく", "pos": "pronoun" },
    { "surface": "たちは", "reading": null, "pos": "particle" }
  ]
}

Rules:
- "surface" is the original text of the token
- "reading" is the hiragana reading only for kanji — null for hiragana, katakana, romaji, or punctuation
- "pos" must be one of exactly: noun, verb, adjective, adverb, particle, conjunction, pronoun, interjection, other
- "translation" is a natural English translation of the whole line
- Keep tokens granular — split verb stems from conjugation endings where possible
- Return ONLY the JSON array, no markdown backticks, no explanation, no preamble

Lines:
${JSON.stringify(lines)}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    const raw      = response.text.replace(/```json|```/g, '').trim();
    const annotated = JSON.parse(raw);
    res.json({ annotated });

  } catch (err) {
    console.error('Annotation error:', err);
    // fall back — return lines with empty annotation so frontend doesn't break
    res.json({
      annotated: lines.map(line => ({
        original:    line,
        translation: '',
        tokens:      [{ surface: line, reading: null, pos: 'other' }]
      }))
    });
  }
});
