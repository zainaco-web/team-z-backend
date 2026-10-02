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
  return { teamProgress: [], assignments: [], tlRosters: [], agentDirectory: [], manualNameOverrides: {}, feedback: [], customScenarios: [] };
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
// UPDATED: these used to be admin-edited, low-frequency, single-TL operations, which is why they
// were originally built as full-replace. That assumption no longer holds now that multiple TLs are
// testing concurrently - two TLs registering different agents around the same time could otherwise
// each fetch the array, add their own agent locally, and POST the whole thing back; whichever POST
// lands second silently erases the other TL's new agent/roster entry (a classic lost-update race).
// The /upsert endpoints below fix this the same way assignments/:id and feedback/:id already do:
// a single synchronous read-modify-write per request, with no "fetch the old array into the
// frontend, mutate it there, send the whole thing back" round trip for anyone else's edits to be
// lost in. The original full-replace endpoints are kept immediately below, UNCHANGED, as a manual
// "force full resync" escape hatch only - no current frontend flow relies on them for normal use.

// Upsert ONE agent profile by canonicalName (case-insensitive). Never touches any other profile.
app.post('/api/store/agent-directory/upsert', (req, res) => {
  const profile = req.body;
  if(!profile || typeof profile !== 'object' || !profile.canonicalName) return res.status(400).json({ error: 'Request body must be a profile object with a "canonicalName" field.' });
  const data = readStore();
  data.agentDirectory = data.agentDirectory || [];
  const key = String(profile.canonicalName).trim().toLowerCase();
  const idx = data.agentDirectory.findIndex(a => String((a && a.canonicalName) || '').trim().toLowerCase() === key);
  if (idx >= 0) data.agentDirectory[idx] = profile; else data.agentDirectory.push(profile);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, agentDirectory: data.agentDirectory });
});

// Upsert/merge agents into ONE TL's roster by tlName (case-insensitive). Creates the roster if it
// doesn't exist yet. addAgents is unioned into the existing list (case-insensitive dedupe) - this
// never removes an agent, matching every current frontend caller (there is no "remove agent from
// roster" flow today). Every other TL's roster entry in the array is left completely untouched.
app.post('/api/store/tl-rosters/upsert', (req, res) => {
  const { tlName, addAgents } = req.body || {};
  if (!tlName || typeof tlName !== 'string') return res.status(400).json({ error: 'Request body must include a "tlName" string.' });
  const toAdd = Array.isArray(addAgents) ? addAgents.filter(Boolean) : [];
  const data = readStore();
  data.tlRosters = data.tlRosters || [];
  const key = tlName.trim().toLowerCase();
  const idx = data.tlRosters.findIndex(r => String((r && r.tlName) || '').trim().toLowerCase() === key);
  if (idx >= 0) {
    const agents = data.tlRosters[idx].agents ? data.tlRosters[idx].agents.slice() : [];
    toAdd.forEach(a => { if (!agents.some(existing => String(existing).trim().toLowerCase() === String(a).trim().toLowerCase())) agents.push(a); });
    data.tlRosters[idx] = { tlName: data.tlRosters[idx].tlName, agents };
  } else {
    data.tlRosters.push({ tlName: tlName.trim(), agents: toAdd });
  }
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, tlRosters: data.tlRosters });
});

// Set ONE key in the manual-name-overrides map. Merges into the existing map rather than replacing
// it, so two TLs resolving two different ambiguous names at the same time can't erase one another.
app.post('/api/store/manual-name-overrides/set', (req, res) => {
  const { key, canonicalName } = req.body || {};
  if (!key || typeof key !== 'string' || !canonicalName) return res.status(400).json({ error: 'Request body must include "key" and "canonicalName" strings.' });
  const data = readStore();
  data.manualNameOverrides = data.manualNameOverrides || {};
  data.manualNameOverrides[key] = canonicalName;
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, manualNameOverrides: data.manualNameOverrides });
});

// ---- Legacy full-replace endpoints ----
// Kept ONLY as a manual "force full resync" escape hatch (e.g. restoring from a known-good export).
// No current frontend flow uses these for normal registration/editing any more - see /upsert above.
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

// ---- Custom Scenarios (TL Scenario Builder) ----
// Same per-record pattern as assignments/feedback above - this is deliberate: several TLs can be
// creating, editing, or reviewing scenarios at the same moment, and a whole-array replace here would
// have exactly the lost-update race that assignments/feedback/tlRosters already had to be fixed for.
// Every write below touches ONE scenario record by its own unique id; nothing here ever reads the
// array, mutates it in the browser, and posts the whole thing back.

// Create ONE new custom scenario. Body must include a client-generated "id" (see work.html for the
// id-generation scheme - timestamp + device fragment + random, so two TLs creating at the same
// instant on different devices still can't collide).
app.post('/api/store/custom-scenarios/new', (req, res) => {
  const entry = req.body;
  if (!entry || typeof entry !== 'object' || !entry.id) return res.status(400).json({ error: 'Request body must be a scenario object with an "id" field.' });
  const data = readStore();
  data.customScenarios = data.customScenarios || [];
  if (data.customScenarios.some(s => s.id === entry.id)) return res.status(409).json({ error: 'A custom scenario with that id already exists.' });
  data.customScenarios.push(entry);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved });
});

// Merge-update ONE custom scenario by id - used for TL edits, duplicating-then-editing, visibility
// changes, and reviewer actions (reviewStatus/reviewedBy/reviewedDate/reviewNotes/kbStatus).
app.patch('/api/store/custom-scenarios/:id', (req, res) => {
  const patch = req.body;
  if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Request body must be an object of fields to update.' });
  const data = readStore();
  data.customScenarios = data.customScenarios || [];
  const idx = data.customScenarios.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No custom scenario with that id.' });
  data.customScenarios[idx] = Object.assign({}, data.customScenarios[idx], patch);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, scenario: data.customScenarios[idx] });
});

// Delete (archive/remove) ONE custom scenario by id. Never touches teamProgress/assignments - an
// attempt or assignment that already referenced this scenario keeps its own saved snapshot of the
// scenario id/title and is unaffected by the scenario itself being removed from the library.
app.delete('/api/store/custom-scenarios/:id', (req, res) => {
  const data = readStore();
  data.customScenarios = data.customScenarios || [];
  const before = data.customScenarios.length;
  data.customScenarios = data.customScenarios.filter(s => s.id !== req.params.id);
  const saved = writeStore(data);
  res.json({ ok: true, persisted: DISK_MOUNTED, saved, removed: before - data.customScenarios.length });
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
