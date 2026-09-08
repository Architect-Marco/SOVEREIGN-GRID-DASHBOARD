// -----------------------------------------------------------------------
// Vocal render proxy — ElevenLabs streaming TTS
//
// Mount this in server.js with:
//   import vocalRouter from './vocal-render.js';
//   app.use(vocalRouter);
//
// Requires these in .env / Render env vars:
//   ELEVENLABS_API_KEY
//   ELEVENLABS_VOICE_ID_ELLEN   (paid plan required — see note below)
//   ELEVENLABS_VOICE_ID_JANE    (paid plan required — see note below)
//   ELEVENLABS_VOICE_ID_ANNIE   (still returned 402 — Library-added voice, owner-restricted)
//   ELEVENLABS_VOICE_ID_BELLA   (default account voice — best free-tier candidate so far)
//
// NOTE: Ellen, Jane, and Annie are all voices manually added to the
// account from ElevenLabs' shared Voice Library — each Library voice's
// owner can independently restrict free-tier API access, and all three
// returned a 402 "paid_plan_required" error. Bella (and other voices
// bundled by default with the account, e.g. Roger/Sarah/Laura/Charlie/
// George) are NOT Library additions and are a better bet for free-tier
// API access — use voiceKey: 'bella' until confirmed, or until the plan
// is upgraded.
// -----------------------------------------------------------------------
import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const VOICE_MAP = {
  ellen: process.env.ELEVENLABS_VOICE_ID_ELLEN,
  jane: process.env.ELEVENLABS_VOICE_ID_JANE,
  annie: process.env.ELEVENLABS_VOICE_ID_ANNIE,
  bella: process.env.ELEVENLABS_VOICE_ID_BELLA,
};

router.post('/api/vocal/render', async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not set — add it to .env' });
  }

  const { voiceKey, text, modelId, stability, similarityBoost } = req.body;

  if (!voiceKey || !text) {
    return res.status(400).json({ error: 'voiceKey and text are required' });
  }

  const voiceId = VOICE_MAP[voiceKey];
  if (!voiceId) {
    return res.status(400).json({ error: `Unknown voiceKey: ${voiceKey}` });
  }

  if (typeof text !== 'string' || text.length === 0 || text.length > 5000) {
    return res.status(400).json({ error: 'text must be 1-5000 characters' });
  }

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: modelId || 'eleven_multilingual_v2',
          voice_settings: {
            stability: stability ?? 0.5,
            similarity_boost: similarityBoost ?? 0.75,
          },
        }),
      }
    );

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      console.error('ElevenLabs upstream error:', upstream.status, errText);
      return res.status(502).json({ error: 'Upstream voice render failed' });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    });

    // Pipe the upstream stream straight through to the client response —
    // audio starts playing as bytes arrive instead of waiting for the
    // full file to buffer.
    upstream.body.pipe(res);
  } catch (err) {
    console.error('Vocal render exception:', err.message);
    res.status(500).json({ error: 'Vocal render failed' });
  }
});

export default router;
