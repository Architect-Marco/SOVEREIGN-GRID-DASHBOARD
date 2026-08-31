import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import fetch from 'node-fetch';
import FormData from 'form-data';

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// CORS — the frontend (GitHub Pages) and this backend (Render) live on
// different origins, so cross-origin requests need to be explicitly allowed.
// Set ALLOWED_ORIGIN in Render's env vars to your Pages URL, e.g.
// https://architect-marco.github.io — no trailing slash.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AUDD_API_KEY = process.env.AUDD_API_KEY;
const REJECT_THRESHOLD = Number(process.env.REJECT_THRESHOLD ?? 85);
const FLAG_THRESHOLD = Number(process.env.FLAG_THRESHOLD ?? 40);

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB cap for demo purposes
  fileFilter: (req, file, cb) => {
    const ok = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4'].includes(file.mimetype);
    cb(ok ? null : new Error('Unsupported file type — use mp3, wav, or m4a'), ok);
  }
});

// ---------------------------------------------------------------------------
// Fake "DB" — swap for Postgres/Mongo/whatever in a real build.
// Two tables: tracks (everything creators upload) and reviewQueue (flagged items).
// ---------------------------------------------------------------------------
const db = {
  tracks: new Map(),      // trackId -> track record
  reviewQueue: new Map(), // trackId -> review case
};

app.use(express.json());
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// AetherWave integration — AI music generation bridge
//
// ⚠️ VERIFY BEFORE PRODUCTION USE: several field/endpoint names below are
// based on what was described in chat, not a confirmed API doc. Anything
// marked "UNVERIFIED" below must be checked against AetherWave's real docs
// before this is trusted with real credits. Wrong field names will likely
// fail loudly (safe) — but a wrong *polling* endpoint could hang forever or
// silently never detect completion, which is why the guardrails below exist.
// ---------------------------------------------------------------------------
const AETHERWAVE_API_KEY = process.env.AETHERWAVE_API_KEY;
const AETHERWAVE_BASE_URL = 'https://aetherwavestudio.com'; // confirmed via aetherwavestudio.com/developers
const AETHERWAVE_CREDIT_COST_PER_GEN = 20; // confirmed: 20 credits, returns 2 tracks, on every model/plan

// "Sovereign Template" — The Sick Team's locked default generation params.
// IMPORTANT: AetherWave's real /api/generate-music schema (confirmed from
// their docs) has no dedicated bpm/vibe/frequency fields — custom mode only
// takes { customMode, prompt (LITERAL LYRICS, not a description), style
// (free-text musical direction), title, vocalGender, instrumental, model }.
// So "108 BPM", "Matte Obsidian", "528Hz", and "Noir" all get folded into
// the `style` string as descriptive text — there's no field to "lock" them
// into structurally. This is how Suno's custom mode actually works, not a
// shortcut taken here.
//
// Also: because custom mode requires real lyrics in `prompt`, this template
// can default everything EXCEPT the lyrics — those have to be supplied per
// call (see startGeneration below). A single hardcoded lyric set reused for
// "every generation" would produce identical vocals on every track.
const SOVEREIGN_TEMPLATE = {
  customMode: true,
  style: 'Noir, 108 BPM, Matte Obsidian vibe, 528Hz tuning', // "Lexi Con" vocal persona has no dedicated field — folded in below via vocalGender + style, adjust if "Lexi Con" means something more specific you want reflected in the style text
  vocalGender: 'f', // UNVERIFIED ASSUMPTION — "Lexi Con Vocals" implies a specific persona/voice; confirm whether that maps to 'f', 'm', or needs describing in `style` instead
  instrumental: false,
  model: 'V5_5',
};

// ---- Vault Guardrails: credit + rate-limit protection ----------------------
// In-memory only for this demo — restart clears these counters. A real
// deployment should persist this (DB/Redis) so a server restart can't reset
// the loop-protection counters.
const GEN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const GEN_RATE_LIMIT_MAX = Number(process.env.AETHERWAVE_RATE_LIMIT ?? 5); // max generations per window
const GEN_SESSION_HARD_CAP = Number(process.env.AETHERWAVE_SESSION_CAP ?? 20); // absolute cap since server start — protects the 800-credit pool from a runaway loop even across the rate-limit window
let generationTimestamps = []; // rolling window for rate limiting
let sessionGenerationCount = 0; // lifetime-since-restart count, for the hard cap

function pruneGenerationTimestamps() {
  const cutoff = Date.now() - GEN_RATE_LIMIT_WINDOW_MS;
  generationTimestamps = generationTimestamps.filter((t) => t > cutoff);
}

// Checks AetherWave's real balance — this is the source of truth, not a
// locally-tracked counter, so it can't drift out of sync with what
// AetherWave actually thinks you have.
async function getAetherWaveBalance() {
  if (!AETHERWAVE_API_KEY) {
    throw new Error('AETHERWAVE_API_KEY is not set — add it to .env');
  }
  const res = await fetch(`${AETHERWAVE_BASE_URL}/api/quickstart/balance`, {
    headers: { 'X-AW-Key': AETHERWAVE_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`AetherWave balance check failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  // UNVERIFIED shape — assuming { credits: number }. Adjust if their real
  // response nests this differently (e.g. { balance: { credits } }).
  const credits = data.credits ?? data.balance ?? null;
  if (credits === null) {
    throw new Error(`Unexpected balance response shape: ${JSON.stringify(data)}`);
  }
  return credits;
}

// The actual guardrail check, run before every generation attempt.
// Returns { ok: true } or { ok: false, reason, ...details } — never throws
// for an expected "can't proceed" case, so the caller can surface a clean
// HUD alert instead of a raw error.
async function checkVaultGuardrails() {
  pruneGenerationTimestamps();

  if (sessionGenerationCount >= GEN_SESSION_HARD_CAP) {
    return {
      ok: false,
      reason: 'session_cap_reached',
      message: `Hard session cap of ${GEN_SESSION_HARD_CAP} generations reached since server start. Restart the server to reset this safety limit (it exists specifically to stop a runaway loop from burning the whole credit pool unattended).`,
    };
  }

  if (generationTimestamps.length >= GEN_RATE_LIMIT_MAX) {
    return {
      ok: false,
      reason: 'rate_limited',
      message: `Rate limit hit: ${GEN_RATE_LIMIT_MAX} generations already fired in the last ${GEN_RATE_LIMIT_WINDOW_MS / 60000} minutes. Wait before trying again — this is what stops an accidental loop from burning through credits fast.`,
    };
  }

  let credits;
  try {
    credits = await getAetherWaveBalance();
  } catch (err) {
    return { ok: false, reason: 'balance_check_failed', message: err.message };
  }

  if (credits < AETHERWAVE_CREDIT_COST_PER_GEN) {
    return {
      ok: false,
      reason: 'insufficient_credits',
      message: `Only ${credits} credits left — need ${AETHERWAVE_CREDIT_COST_PER_GEN} per generation.`,
      credits,
    };
  }

  return { ok: true, credits };
}

// ---- Generation + polling ---------------------------------------------------
// `lyrics` is required per call — AetherWave's custom mode uses `prompt` as
// the literal song lyrics, which can't sensibly be hardcoded once for every
// generation. Everything else defaults from SOVEREIGN_TEMPLATE unless overridden.
async function startGeneration(lyrics, overrides = {}) {
  if (!AETHERWAVE_API_KEY) {
    throw new Error('AETHERWAVE_API_KEY is not set — add it to .env');
  }
  if (!lyrics || typeof lyrics !== 'string') {
    throw new Error('lyrics is required — AetherWave custom mode needs literal lyrics in the prompt field, not a description');
  }

  const body = { ...SOVEREIGN_TEMPLATE, ...overrides, prompt: lyrics };

  const res = await fetch(`${AETHERWAVE_BASE_URL}/api/generate-music`, {
    method: 'POST',
    headers: {
      'X-AW-Key': AETHERWAVE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    // Surface AetherWave's documented error codes distinctly when present,
    // so a blocked/failed generation is easy to diagnose from the message
    // alone (INVALID_API_KEY, INSUFFICIENT_CREDITS, RATE_LIMIT_EXCEEDED,
    // GENERATION_FAILED, INVALID_MODEL — per their docs).
    throw new Error(`AetherWave generation request failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const taskId = data.taskId; // confirmed field name from docs
  if (!taskId) {
    throw new Error(`AetherWave response had no taskId: ${JSON.stringify(data)}`);
  }
  return { taskId, requestBody: body };
}

// Confirmed endpoint: GET /api/music-status/:taskId (X-AW-Key required).
// Confirmed response shape:
//   processing: { status: 'processing' | 'pending', ... } (exact intermediate
//     shape not shown in docs — handled generically below)
//   complete:   { status: 'complete', tracks: [{ id, audioUrl, title, duration }, {...}] }
//   Job IDs expire after 7 days — a 404 after that long means the task is gone,
//   not necessarily failed.
async function pollGenerationStatus(taskId) {
  const res = await fetch(`${AETHERWAVE_BASE_URL}/api/music-status/${taskId}`, {
    headers: { 'X-AW-Key': AETHERWAVE_API_KEY },
  });
  if (res.status === 404) {
    return { status: 'expired_or_not_found' };
  }
  if (!res.ok) {
    throw new Error(`AetherWave status check failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---- In-memory task tracking for this demo ---------------------------------
// taskId -> { status, requestBody, audioUrl, draftTrackId, error, startedAt }
const generationTasks = new Map();

// ---------------------------------------------------------------------------
// GET /api/sovereign/balance — HUD check, no generation triggered.
// ---------------------------------------------------------------------------
app.get('/api/sovereign/balance', async (req, res) => {
  try {
    const credits = await getAetherWaveBalance();
    res.json({ credits, costPerGeneration: AETHERWAVE_CREDIT_COST_PER_GEN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sovereign/produce — "One-Button Produce"
// Runs the Vault Guardrails check, then fires a generation using the
// Sovereign Template (with optional per-request overrides). Returns
// immediately with a taskId since AetherWave's flow is async — the frontend
// polls GET /api/sovereign/produce/:taskId to check progress.
// ---------------------------------------------------------------------------
app.post('/api/sovereign/produce', async (req, res) => {
  const guard = await checkVaultGuardrails();
  if (!guard.ok) {
    // HUD alert instead of a hard failure — this is the "alert the HUD
    // instead of failing the extraction" behavior that was asked for.
    return res.status(200).json({ blocked: true, ...guard });
  }

  const { lyrics, overrides } = req.body ?? {};
  if (!lyrics) {
    return res.status(400).json({ blocked: true, reason: 'missing_lyrics', message: 'lyrics is required — AetherWave custom mode needs literal lyrics, not a description. Style/vibe/model can still come from the Sovereign Template.' });
  }

  try {
    const { taskId, requestBody } = await startGeneration(lyrics, overrides ?? {});

    generationTimestamps.push(Date.now());
    sessionGenerationCount++;

    generationTasks.set(taskId, {
      status: 'pending',
      requestBody,
      draftTrackIds: [],
      error: null,
      startedAt: new Date().toISOString(),
    });

    res.json({
      blocked: false,
      taskId,
      creditsRemaining: guard.credits - AETHERWAVE_CREDIT_COST_PER_GEN,
      message: 'Generation started. Poll GET /api/sovereign/produce/:taskId for status.',
    });
  } catch (err) {
    res.status(500).json({ blocked: true, reason: 'generation_failed', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sovereign/produce/:taskId — poll status.
// The first time this sees "completed" from AetherWave, it runs the Direct
// Extraction pipeline: download audioUrl -> fingerprint-check it -> create a
// DRAFT listing (status 'draft', not live) for manual review before publish,
// per "I want to personally review the signal before it goes live."
// ---------------------------------------------------------------------------
app.get('/api/sovereign/produce/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const task = generationTasks.get(taskId);
  if (!task) return res.status(404).json({ error: 'Unknown taskId' });

  // Already fully processed — just return the cached result, no need to
  // re-poll AetherWave or re-ingest.
  if (task.status === 'draft_ready' || task.status === 'failed') {
    return res.json(task);
  }

  try {
    const remote = await pollGenerationStatus(taskId);
    if (remote.status === 'complete' && Array.isArray(remote.tracks)) {
      await ingestGeneratedTracks(task, remote.tracks);
    } else if (remote.status === 'failed' || remote.status === 'expired_or_not_found') {
      task.status = 'failed';
      task.error = remote.error ?? (remote.status === 'expired_or_not_found' ? 'Task not found — AetherWave job IDs expire after 7 days' : 'AetherWave reported generation failure');
    } else {
      task.status = remote.status ?? 'processing';
    }
  } catch (err) {
    task.status = 'failed';
    task.error = err.message;
  }

  res.json(task);
});

// Direct Extraction pipeline: each AetherWave generation returns TWO tracks
// (confirmed — every generation, every model). Both get downloaded,
// fingerprint-checked, and listed as separate drafts so nothing paid-for
// (20 credits already spent either way) is silently discarded — you pick
// which take, if either, to publish. This is the "Production to Sale with
// zero manual clicks" step, up to (but deliberately NOT past) the draft
// stage — publishing is a separate manual action via
// /api/review-queue/:trackId/resolve, same as any flagged upload.
async function ingestGeneratedTracks(task, tracks) {
  const draftIds = [];

  for (let i = 0; i < tracks.length; i++) {
    const remoteTrack = tracks[i];
    const trackId = nanoid(10);
    const destPath = path.join(UPLOAD_DIR, `${trackId}.mp3`);

    try {
      const audioRes = await fetch(remoteTrack.audioUrl);
      if (!audioRes.ok) throw new Error(`Failed to download generated audio: ${audioRes.status}`);
      const buffer = Buffer.from(await audioRes.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      let fingerprint = null;
      try {
        fingerprint = await checkFingerprint(destPath, trackId);
      } catch (err) {
        // Fail safe, same pattern as the manual upload flow — an unchecked
        // fingerprint result should never be trusted to sit in "draft" or go
        // live silently, so this still requires manual review either way.
        fingerprint = null;
      }

      db.tracks.set(trackId, {
        id: trackId,
        title: remoteTrack.title || `Sovereign Draft — Take ${i + 1} — ${new Date().toLocaleString()}`,
        creatorId: 'sovereign-engine',
        filePath: destPath,
        status: 'draft', // requires manual publish — never auto-live
        fingerprint,
        duration: remoteTrack.duration ?? null,
        generationParams: task.requestBody,
        source: 'aetherwave',
        takeIndex: i,
        uploadedAt: new Date().toISOString(),
      });

      draftIds.push(trackId);
    } catch (err) {
      // One take failing to download/ingest shouldn't block the other —
      // log it on the task and keep going.
      task.error = (task.error ? task.error + '; ' : '') + `Take ${i + 1} ingest failed: ${err.message}`;
    }
  }

  task.status = 'draft_ready';
  task.draftTrackIds = draftIds;
}

// ---------------------------------------------------------------------------
// GET /api/sovereign/drafts — list AetherWave-generated tracks awaiting
// manual review/publish. This is what the "Draft Listing" queue on the
// admin HUD would read from.
// ---------------------------------------------------------------------------
app.get('/api/sovereign/drafts', (req, res) => {
  const drafts = [...db.tracks.values()].filter((t) => t.status === 'draft' && t.source === 'aetherwave');
  res.json(drafts);
});

// ---------------------------------------------------------------------------
// GET /api/tracks/:id — metadata for one track (used by the Create screen to
// label a freshly-generated draft before it starts streaming the audio).
// ---------------------------------------------------------------------------
app.get('/api/tracks/:id', (req, res) => {
  const track = db.tracks.get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  const { filePath, ...safe } = track; // never leak the server filesystem path
  res.json(safe);
});

// ---------------------------------------------------------------------------
// GET /api/tracks/:id/audio — streams the mp3 for playback. This is the URL
// the frontend <audio>/player element points at directly (via src).
// ---------------------------------------------------------------------------
app.get('/api/tracks/:id/audio', (req, res) => {
  const track = db.tracks.get(req.params.id);
  if (!track || !fs.existsSync(track.filePath)) {
    return res.status(404).json({ error: 'Audio not found' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  fs.createReadStream(track.filePath).pipe(res);
});


// ---------------------------------------------------------------------------
// Reliability settings for the fingerprint check itself
// ---------------------------------------------------------------------------
const AUDD_TIMEOUT_MS = 15_000;      // give up waiting on AudD after 15s
const AUDD_MAX_RETRIES = 2;          // retry transient failures before failing safe
const AUDD_RETRY_DELAY_MS = 1_500;   // wait between retries

// Every check attempt gets logged here — this is what lets you monitor whether
// the fingerprint check is actually healthy over time, not just per-request.
// Swap for a real logging service (e.g. writing to a file or a monitoring
// tool) once this isn't just running on a laptop.
const checkLog = [];
function logCheckAttempt(entry) {
  checkLog.push({ ...entry, at: new Date().toISOString() });
  if (checkLog.length > 500) checkLog.shift(); // keep it bounded in memory
  const tag = entry.outcome === 'error' ? '⚠️ ' : '';
  console.log(`${tag}[fingerprint] ${entry.outcome} — trackId=${entry.trackId ?? 'n/a'} attempt=${entry.attempt}${entry.detail ? ' — ' + entry.detail : ''}`);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// A quick, free, always-available first-pass check that doesn't depend on
// AudD being up at all: exact-duplicate file detection via content hash.
// This catches "someone re-uploaded the identical file" instantly, and still
// works even during an AudD outage — it's not a substitute for the real
// fingerprint check, just a cheap extra layer that never goes down.
import crypto from 'node:crypto';
const seenFileHashes = new Map(); // hash -> trackId of first upload
function hashFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// Core: send audio to AudD's recognition endpoint, with timeout + retries.
// Docs: https://docs.audd.io/
// ---------------------------------------------------------------------------
async function callAudD(filePath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDD_TIMEOUT_MS);

  try {
    const form = new FormData();
    form.append('api_token', AUDD_API_KEY);
    form.append('file', fs.createReadStream(filePath));
    form.append('return', 'apple_music,spotify');

    const res = await fetch('https://api.audd.io/', {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    // AudD rate-limits (HTTP 429) are worth distinguishing from a hard failure —
    // they're transient and worth retrying; other 4xx/5xx errors likely aren't.
    if (res.status === 429) {
      throw Object.assign(new Error('AudD rate limit hit'), { retryable: true });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`AudD request failed: ${res.status} ${res.statusText}`), { retryable: res.status >= 500 });
    }

    const data = await res.json();
    if (data.status !== 'success') {
      throw Object.assign(new Error(`AudD error: ${JSON.stringify(data.error ?? data)}`), { retryable: false });
    }

    if (!data.result) {
      return { matched: false, score: 0, details: null };
    }

    const score = data.result.score ?? (data.result.title ? 90 : 0);
    return {
      matched: true,
      score,
      details: {
        title: data.result.title,
        artist: data.result.artist,
        album: data.result.album,
        release_date: data.result.release_date,
        source: data.result.apple_music ? 'apple_music' : data.result.spotify ? 'spotify' : 'audd',
      },
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`AudD request timed out after ${AUDD_TIMEOUT_MS}ms`), { retryable: true });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkFingerprint(filePath, trackId) {
  if (!AUDD_API_KEY) {
    throw new Error('AUDD_API_KEY is not set — copy .env.example to .env and add your key');
  }

  // Layer 1: exact-duplicate check — free, instant, works even if AudD is down.
  // Record the hash immediately on first sight (not just after a successful
  // AudD check) — this is what lets it keep catching re-uploads of the exact
  // same file even during an AudD outage, which is exactly when it matters most.
  const fileHash = hashFile(filePath);
  if (seenFileHashes.has(fileHash)) {
    const originalTrackId = seenFileHashes.get(fileHash);
    logCheckAttempt({ trackId, attempt: 0, outcome: 'duplicate-detected', detail: `matches trackId ${originalTrackId}` });
    return {
      matched: true,
      score: 100,
      details: { title: 'Exact duplicate of a previous upload', artist: null, album: null, release_date: null, source: 'internal-hash' },
    };
  }
  seenFileHashes.set(fileHash, trackId);

  // Layer 2: the real fingerprint check, with retries on transient failures.
  let lastErr;
  for (let attempt = 1; attempt <= AUDD_MAX_RETRIES + 1; attempt++) {
    try {
      const result = await callAudD(filePath);
      logCheckAttempt({ trackId, attempt, outcome: 'success', detail: result.matched ? `matched score=${result.score}` : 'no match' });
      return result;
    } catch (err) {
      lastErr = err;
      logCheckAttempt({ trackId, attempt, outcome: 'error', detail: err.message });
      if (!err.retryable || attempt > AUDD_MAX_RETRIES) break;
      await sleep(AUDD_RETRY_DELAY_MS * attempt); // simple backoff
    }
  }

  // Every retry exhausted — this is a genuine failure, not a match result.
  // The caller (upload endpoint) is responsible for failing safe: hold for
  // review rather than either auto-clearing or crashing.
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Routing logic — decides what happens to a track after the fingerprint check
// ---------------------------------------------------------------------------
function routeDecision(score) {
  if (score >= REJECT_THRESHOLD) return 'rejected';
  if (score >= FLAG_THRESHOLD) return 'flagged';
  return 'cleared';
}

// ---------------------------------------------------------------------------
// POST /api/tracks/upload
// Creator uploads a track. We run it through the fingerprint check immediately
// and respond with the outcome. This is synchronous for the demo; in production
// you'd likely queue this (e.g. BullMQ) so upload doesn't block on the API call.
// ---------------------------------------------------------------------------
app.post('/api/tracks/upload', upload.single('audio'), async (req, res) => {
  const { title, creatorId, aiTool, aiTier, licenseType, price } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
  if (!title || !creatorId) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'title and creatorId are required' });
  }

  const trackId = nanoid(10);

  try {
    const fingerprint = await checkFingerprint(req.file.path, trackId);
    const decision = routeDecision(fingerprint.score);

    const track = {
      id: trackId,
      title,
      creatorId,
      aiTool: aiTool ?? null,
      aiTier: aiTier ?? null,
      licenseType: licenseType ?? 'one-off-nonexclusive',
      price: price ?? null,
      filePath: req.file.path,
      status: decision, // 'cleared' | 'flagged' | 'rejected'
      fingerprint,
      uploadedAt: new Date().toISOString(),
    };

    db.tracks.set(trackId, track);

    if (decision === 'flagged') {
      db.reviewQueue.set(trackId, {
        trackId,
        reason: 'fingerprint_match',
        matchScore: fingerprint.score,
        matchDetails: fingerprint.details,
        status: 'pending_review',
        createdAt: new Date().toISOString(),
      });
    }

    if (decision === 'rejected') {
      // Don't keep the audio file for an auto-rejected track in this demo.
      fs.unlinkSync(req.file.path);
    }

    return res.json({
      trackId,
      status: decision,
      message:
        decision === 'cleared'
          ? 'No significant match found. Track is live.'
          : decision === 'flagged'
          ? 'Possible match found. Track is held for manual review before it can be listed.'
          : 'High-confidence match to an existing copyrighted recording. Upload rejected.',
      fingerprint,
    });
  } catch (err) {
    // Fail safe: if the fingerprint API itself fails, don't silently publish
    // the track — send it to manual review instead of trusting an unchecked upload.
    db.tracks.set(trackId, {
      id: trackId,
      title,
      creatorId,
      filePath: req.file.path,
      status: 'flagged',
      fingerprint: null,
      uploadedAt: new Date().toISOString(),
    });
    db.reviewQueue.set(trackId, {
      trackId,
      reason: 'fingerprint_check_failed',
      error: err.message,
      status: 'pending_review',
      createdAt: new Date().toISOString(),
    });

    return res.status(202).json({
      trackId,
      status: 'flagged',
      message: 'Fingerprint check failed — track held for manual review as a precaution.',
      error: err.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Review queue endpoints — what an admin/moderator would use
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Monitoring — lets you see whether the fingerprint check is actually
// healthy over time, not just whether the last request happened to work.
// ---------------------------------------------------------------------------
app.get('/api/fingerprint-health', (req, res) => {
  const recent = checkLog.slice(-100);
  const errors = recent.filter((e) => e.outcome === 'error');
  const successes = recent.filter((e) => e.outcome === 'success' || e.outcome === 'duplicate-detected');

  res.json({
    window: `last ${recent.length} attempts`,
    successCount: successes.length,
    errorCount: errors.length,
    errorRate: recent.length ? (errors.length / recent.length) : 0,
    recentErrors: errors.slice(-10),
    log: recent,
  });
});

app.get('/api/review-queue', (req, res) => {
  const items = [...db.reviewQueue.values()].map((c) => ({
    ...c,
    track: db.tracks.get(c.trackId),
  }));
  res.json(items);
});

app.post('/api/review-queue/:trackId/resolve', (req, res) => {
  const { trackId } = req.params;
  const { decision } = req.body; // 'approve' | 'reject'

  const track = db.tracks.get(trackId);
  const caseItem = db.reviewQueue.get(trackId);
  if (!track || !caseItem) return res.status(404).json({ error: 'Not found' });

  if (decision === 'approve') {
    track.status = 'cleared';
  } else if (decision === 'reject') {
    track.status = 'rejected';
    if (fs.existsSync(track.filePath)) fs.unlinkSync(track.filePath);
  } else {
    return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
  }

  caseItem.status = 'resolved';
  caseItem.resolution = decision;
  caseItem.resolvedAt = new Date().toISOString();

  res.json({ track, case: caseItem });
});

// ---------------------------------------------------------------------------
// Simple track listing endpoint (only 'cleared' tracks would show in a real browse page)
// ---------------------------------------------------------------------------
app.get('/api/tracks', (req, res) => {
  const onlyLive = req.query.status !== 'all';
  const tracks = [...db.tracks.values()].filter((t) => (onlyLive ? t.status === 'cleared' : true));
  res.json(tracks);
});

// ---------------------------------------------------------------------------
// AI assistant — answers buyer/creator questions using real site policy as
// context, instead of a hardcoded lookup table.
// ---------------------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-5';

// This is the assistant's actual knowledge — your real policies. Edit this as
// your terms change. In a bigger build, pull the live seller agreement /
// license terms from your DB instead of hardcoding it here.
const SITE_KNOWLEDGE = `
You are the support assistant for Traceback, a marketplace for buying and selling music (AI-made, human-made, or both) with transparent provenance and licensing.

KEY POLICIES:
- Every track is checked with an audio fingerprinting service (AudD) before it can go live. Tracks that closely match an existing copyrighted recording are auto-rejected; ambiguous matches go to a human review queue; clean tracks go live automatically.
- Sales are one-off, flat-fee purchases — no royalties. Two license types: "non-exclusive" (creator keeps the right to resell the track to others) and "exclusive" (buyer gets sole rights, creator can't resell it after).
- A non-exclusive license covers monetized use (e.g. YouTube, podcasts, ads) — the buyer just can't resell the track itself or claim exclusive ownership.
- Every track shows a provenance meter: the % of the track that's AI-generated vs. human-produced, based on what the creator (or the platform's own generation flow) discloses.
- Refunds: automatic and full if a track is later confirmed to infringe someone else's copyright. Other refund requests (e.g. buyer's remorse) are reviewed by a human — the assistant should not promise a refund outcome, just explain that a human will follow up.
- To sell on Traceback: create a seller account, agree to the Seller Agreement (which requires confirming you own or have licensed rights to what you upload), then upload a track — it gets fingerprint-checked automatically before going live.
- To register: click "Start selling" or "Log in" in the top nav, choose "Buy music" or "Sell music," fill in the form. Selling requires additional fields (artist name, payout email) and agreeing to the Seller Agreement.
- Creators see their sales and track status (Live / In review / Rejected) on their Dashboard, with a live activity feed showing each sale as it happens.
- Copyright disputes: anyone can file a claim; flagged tracks are held while a human reviews evidence from both sides.

TONE: Plain, direct, concise (2-4 sentences typically). Never invent policy details not listed above — if you don't know, say a human will need to follow up. Never promise a specific refund or dispute outcome. For anything involving money, refunds, or disputes, always mention that a human reviews it before anything is finalized.
`.trim();

app.post('/api/assistant', async (req, res) => {
  const { question } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set — add it to .env to enable the assistant.',
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 400,
        system: SITE_KNOWLEDGE,
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const answer = data.content?.find((block) => block.type === 'text')?.text
      ?? "Sorry, I couldn't generate a response just now.";

    res.json({ answer });
  } catch (err) {
    console.error('Assistant error:', err.message);
    res.status(500).json({ error: 'Failed to reach the assistant. Try again in a moment.' });
  }
});

app.listen(PORT, () => {
  console.log(`AI music upload flow demo running on http://localhost:${PORT}`);
  if (!AUDD_API_KEY) {
    console.warn('⚠️  AUDD_API_KEY not set — uploads will fail until you add one to .env');
  }
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set — the chat assistant will not respond until you add one to .env');
  }
  if (!AETHERWAVE_API_KEY) {
    console.warn('⚠️  AETHERWAVE_API_KEY not set — the AetherWave bridge (/api/sovereign/*) will fail until you add one to .env');
  }
});
