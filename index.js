// Minimal backend server for the Team Z Coaching Pilot.
// Holds ONE Anthropic API key (set as an environment variable, never in code).
// Any browser can call this server's /api/chat endpoint - it doesn't matter what
// Claude account (if any) the person in that browser has, because this server
// never asks their account for anything. It just needs its own API key.

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
  res.json({ status: 'ok', message: 'Team Z Coaching Pilot backend is running.', hasApiKey: !!ANTHROPIC_API_KEY });
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
