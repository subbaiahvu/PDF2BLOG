// ─── Vercel serverless config ───────────────────────────────────────────────
// Increase body size limit to 20MB to handle large PDF base64 payloads
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};
// ────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── API KEY CHECK ─────────────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not set. In Vercel: Settings → Environment Variables → add GEMINI_API_KEY → Redeploy.'
    });
  }

  // ── PARSE BODY ────────────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Empty or invalid request body.' });
  }

  const { systemPrompt, userPrompt, pdfBase64 } = body;

  if (!pdfBase64) {
    return res.status(400).json({ error: 'No PDF data received. Please upload a PDF file.' });
  }
  if (!systemPrompt || !userPrompt) {
    return res.status(400).json({ error: 'Missing systemPrompt or userPrompt.' });
  }

  // ── BUILD GEMINI REQUEST ──────────────────────────────────────────────────
  const geminiBody = {
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{
      role: 'user',
      parts: [
        {
          inline_data: {
            mime_type: 'application/pdf',
            data: pdfBase64
          }
        },
        { text: userPrompt }
      ]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
    }
  };

  // ── CALL GEMINI ───────────────────────────────────────────────────────────
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    // Safe text read first — never call .json() directly on unknown responses
    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error('Non-JSON response from Gemini:', rawText.slice(0, 400));
      return res.status(502).json({
        error: `Gemini returned an unexpected response (HTTP ${response.status}). Check your API key and try again.`
      });
    }

    // Gemini API-level error
    if (!response.ok || data.error) {
      const msg = data?.error?.message || `Gemini API error (HTTP ${response.status})`;
      console.error('Gemini API error:', msg);
      return res.status(response.status || 500).json({ error: msg });
    }

    // Extract generated text
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      const stopReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
      return res.status(500).json({
        error: `Gemini returned empty content. Stop reason: ${stopReason}. Try a different PDF or try again.`
      });
    }

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({
      error: `Server error: ${err.message || 'Unknown error'}. Please try again.`
    });
  }
}

