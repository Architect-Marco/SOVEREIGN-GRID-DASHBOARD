// minimax-proxy-server.js
// A tiny backend that stands between your Create page and MiniMax's real API.
// Your MiniMax key lives ONLY here (as an environment variable), never in the HTML.
//
// Run locally:   MINIMAX_API_KEY=your_key node minimax-proxy-server.js
// Deploy on:      Render / Railway / Fly.io / a Vercel serverless function / any small VPS
//
// npm install express cors

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());              // lock this down to your actual domain before going live
app.use(express.json());

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_URL = 'https://api.minimax.io/v1/music_generation';

app.post('/generate-track', async (req, res) => {
    const { prompt, lyrics, instrumental } = req.body;

    if (!prompt || (!instrumental && !lyrics)) {
        return res.status(400).json({ error: 'Missing prompt (and lyrics, unless instrumental).' });
    }

    try {
        const minimaxRes = await fetch(MINIMAX_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MINIMAX_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'music-2.6',
                prompt: prompt,
                lyrics: instrumental ? '' : lyrics,
                audio_setting: {
                    sample_rate: 44100,
                    bitrate: 256000,
                    format: 'mp3'
                }
            })
        });

        const data = await minimaxRes.json();

        if (!data || !data.data || !data.data.audio) {
            console.error('MiniMax error response:', data);
            return res.status(502).json({ error: 'MiniMax did not return audio.', details: data });
        }

        // MiniMax returns hex-encoded audio bytes — convert to a data URL
        // the browser's <audio> element can play directly, no file storage needed.
        const audioBuffer = Buffer.from(data.data.audio, 'hex');
        const audioBase64 = audioBuffer.toString('base64');
        const audioDataUrl = `data:audio/mp3;base64,${audioBase64}`;

        res.json({ success: true, audio: audioDataUrl });

    } catch (err) {
        console.error('Proxy error:', err);
        res.status(500).json({ error: 'Generation failed.', details: String(err) });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MiniMax proxy running on port ${PORT}`));
