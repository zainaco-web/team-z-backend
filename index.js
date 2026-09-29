// Minimal backend server for the Team Z Coaching Pilot.
// Holds ONE Anthropic API key (set as an environment variable, never in code).
// Any browser can call this server's /api/chat endpoint - it doesn't matter what
// Claude account (if any) the person in that browser has, because this server
// never asks their account for anything. It just needs its own API key.
//
// SHARED PROGRESS STORAGE: writes to a file at DATA_DIR/store.json. On Render's free tier,
// the filesystem is wiped every time the service spins down from inactivity and back up -
// so this only genuinely persists if a paid instance with a Persistent Disk is attached
// (mounted at DATA_DIR). Without that, this still WORKS, it just won't survive a sleep cycle -
// the code below detects and reports which situation it's in via the health check.

const fs = require('fs');
const path = require('path');

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // allows the frontend (hosted anywhere) to call this server
app.use(express.json({ limit: '2mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY environment variable is not set. The server will start, but every request will fail until this is set.');
}

// Health check - visit this URL in a browser to confirm the server is actually running.
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Team Z Coaching Pilot backend is running.',
    hasApiKey: !!ANTHROPIC_API_KEY,
    // Honest limitation: a writable path looks identical whether it's genuinely a mounted
    // Persistent Disk or just this container's normal (non-durable) filesystem - the only real
    // test is surviving an actual restart, which this endpoint can't perform. This just confirms
    // writes are working right now, not that they'll still be there after a restart.
    storageWritableRightNow: DISK_MOUNTED,
    storageNote: 'Whether this survives a restart depends on whether a Persistent Disk is attached at ' + DATA_DIR + ' in Render settings. See README for how to add one.',
  });
});

// ---------- SHARED STORE (team progress, assignments, rosters, directory, feedback - visible to everyone using this backend) ----------
const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'store.json');
let DISK_MOUNTED = false;
try{
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  DISK_MOUNTED = true;
}catch(err){
  console.warn(`No writable persistent disk at ${DATA_DIR} - shared data will not survive a restart. See README for how to attach one.`);
}

// Everything below runs synchronously (readFileSync/writeFileSync, no async/await between
// reading a record and writing it back) and Node is single-threaded, so each request's
// read-modify-write completes before the next request's handler runs. That's what makes the
// per-record endpoints below (assignments/:id, feedback/:id) safe against two TLs editing at
// the same time - there's no window where one request's write can silently overwrite another's.
function readStore(){
  try{
    if(fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  }catch(err){ console.error('Reading store failed:', err); }
  return { teamProgress: [], assignments: [], tlRosters: [], agentDirectory: [], manualNameOverrides: {}, feedback: [] };
}
function writeStore(data){
  try{
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
    return true;
  }catch(err){
    console.error('Writing store failed (data not saved):', err);
    return false;
  }
}

// GET the whole shared store in one call - simple for a small team.
app.get('/api/store', (req, res) => {
  res.json(readStore());
});

// POST a single new team-progress entry (one completed attempt, or a TL-review record). Appends, doesn't overwrite.
app.post('/api/store/team-progress', (req, res) => {
  const entry = req.body;
  if(!entry || typeof entry !== 'object') return res.status(400).json({ error: 'Request body must be an attempt entry object.' });
  const data = readStore();
  data.teamProgress = data.teamProgress || [];
  data.teamProgress.push(entry);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

// ---- Assignments ----
// Legacy endpoint, kept for backward compatibility with any frontend build that hasn't picked
// up the per-record endpoints below yet: POSTs the full array (TL side overwrites the whole
// list). This has a real lost-update risk if two TLs save around the same time, which is why
// new code should use the three endpoints below instead. Left in place so an old cached
// frontend never 404s.
app.post('/api/store/assignments', (req, res) => {
  const assignments = req.body;
  if(!Array.isArray(assignments)) return res.status(400).json({ error: 'Request body must be an array of assignments.' });
  const data = readStore();
  data.assignments = assignments;
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

// Create ONE new assignment. Body is a single assignment object (must include an "id").
app.post('/api/store/assignments/new', (req, res) => {
  const entry = req.body;
  if(!entry || typeof entry !== 'object' || !entry.id) return res.status(400).json({ error: 'Request body must be an assignment object with an "id" field.' });
  const data = readStore();
  data.assignments = data.assignments || [];
  data.assignments.push(entry);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

// Merge-update ONE assignment by id (e.g. marking it completed, or linking it to an attempt).
app.patch('/api/store/assignments/:id', (req, res) => {
  const patch = req.body;
  if(!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Request body must be an object of fields to update.' });
  const data = readStore();
  data.assignments = data.assignments || [];
  const idx = data.assignments.findIndex(a => a.id === req.params.id);
  if(idx === -1) return res.status(404).json({ error: 'No assignment with that id.' });
  data.assignments[idx] = Object.assign({}, data.assignments[idx], patch);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, assignment: data.assignments[idx] });
});

// Delete ONE assignment by id (used for cancelling / removing a test assignment).
app.delete('/api/store/assignments/:id', (req, res) => {
  const data = readStore();
  data.assignments = data.assignments || [];
  const before = data.assignments.length;
  data.assignments = data.assignments.filter(a => a.id !== req.params.id);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, removed: before - data.assignments.length });
});

// ---- Feedback ----
// Create ONE feedback entry. Body must include a client-generated "id" (stable so it can be
// patched/deleted later without a round trip to fetch what id the server assigned).
app.post('/api/store/feedback', (req, res) => {
  const entry = req.body;
  if(!entry || typeof entry !== 'object' || !entry.id) return res.status(400).json({ error: 'Request body must be a feedback object with an "id" field.' });
  const data = readStore();
  data.feedback = data.feedback || [];
  data.feedback.push(entry);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

// Merge-update ONE feedback entry by id (e.g. {status:'resolved'} or {status:'archived'}).
app.patch('/api/store/feedback/:id', (req, res) => {
  const patch = req.body;
  if(!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Request body must be an object of fields to update.' });
  const data = readStore();
  data.feedback = data.feedback || [];
  const idx = data.feedback.findIndex(f => f.id === req.params.id);
  if(idx === -1) return res.status(404).json({ error: 'No feedback entry with that id.' });
  data.feedback[idx] = Object.assign({}, data.feedback[idx], patch);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, feedback: data.feedback[idx] });
});

// Delete ONE feedback entry by id.
app.delete('/api/store/feedback/:id', (req, res) => {
  const data = readStore();
  data.feedback = data.feedback || [];
  const before = data.feedback.length;
  data.feedback = data.feedback.filter(f => f.id !== req.params.id);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, removed: before - data.feedback.length });
});

// ---- TL Rosters / Agent Directory / manual name overrides ----
// These are admin-edited, low write frequency, and have no per-record delete requirement from
// the frontend today, so a full-replace is a reasonable, simple design here (unlike assignments
// and feedback above, which agents and TLs can both be touching concurrently).
app.post('/api/store/tl-rosters', (req, res) => {
  const tlRosters = req.body;
  if(!Array.isArray(tlRosters)) return res.status(400).json({ error: 'Request body must be an array of TL rosters.' });
  const data = readStore();
  data.tlRosters = tlRosters;
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

app.post('/api/store/agent-directory', (req, res) => {
  const agentDirectory = req.body;
  if(!Array.isArray(agentDirectory)) return res.status(400).json({ error: 'Request body must be an array of agent profiles.' });
  const data = readStore();
  data.agentDirectory = agentDirectory;
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

app.post('/api/store/manual-name-overrides', (req, res) => {
  const overrides = req.body;
  if(!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return res.status(400).json({ error: 'Request body must be an object.' });
  const data = readStore();
  data.manualNameOverrides = overrides;
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

// The one real endpoint. Takes { system?, messages, max_tokens? } and forwards
// to Anthropic's API using the server's own key, then returns the reply.
app.post('/api/chat', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured with an API key. Set ANTHROPIC_API_KEY on the host and redeploy.' });
  }

  const { system, messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "messages" array.' });
  }

  try {
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: max_tokens || 1000,
      messages,
    };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: `Anthropic returned non-JSON (HTTP ${response.status}). Raw: ${rawText.slice(0, 300)}` });
    }

    if (!response.ok || data.type === 'error') {
      return res.status(response.status).json({ error: data.error?.message || data.message || 'Unknown error from Anthropic API' });
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) {
      return res.status(502).json({ error: 'No text content in Anthropic response.' });
    }

    res.json({ text, stop_reason: data.stop_reason });
  } catch (err) {
    console.error('Error calling Anthropic API:', err);
    res.status(500).json({ error: err.message || 'Unknown server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Team Z Coaching Pilot backend listening on port ${PORT}`);
  console.log(`API key configured: ${!!ANTHROPIC_API_KEY}`);
});
