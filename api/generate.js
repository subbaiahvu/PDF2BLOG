// ── CRITICAL: Tell Vercel to accept large JSON bodies (PDFs in base64) ──────
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb',   // base64 of a 13 MB PDF ≈ 17-18 MB JSON
    },
  },
};

export default async function handler(req, res) {

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not set. Go to Vercel → Settings → Environment Variables → add GEMINI_API_KEY → Redeploy.'
    });
  }

  // Parse body — Vercel auto-parses JSON when Content-Type is application/json
  let body = req.body;
  if (!body) {
    return res.status(400).json({ error: 'Empty request body.' });
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Request body is not valid JSON.' }); }
  }

  const { systemPrompt, userPrompt, pdfBase64 } = body;

  if (!pdfBase64)    return res.status(400).json({ error: 'No PDF data in request. Please upload a PDF file.' });
  if (!systemPrompt) return res.status(400).json({ error: 'Missing systemPrompt.' });
  if (!userPrompt)   return res.status(400).json({ error: 'Missing userPrompt.' });

  // Log sizes for debugging (visible in Vercel function logs)
  const base64MB = (pdfBase64.length / (1024 * 1024)).toFixed(2);
  const origMB   = (pdfBase64.length * 0.75 / (1024 * 1024)).toFixed(2);
  console.log(`PDF received: base64=${base64MB}MB, original≈${origMB}MB`);

  // Build Gemini request
  const geminiBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
        { text: userPrompt }
      ]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
    }
  };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    // Always read as text first — never call .json() blindly
    const rawText = await response.text();
    console.log(`Gemini response: HTTP ${response.status}, length=${rawText.length}`);

    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      // Gemini returned non-JSON (HTML error page, network issue, etc.)
      console.error('Non-JSON from Gemini:', rawText.slice(0, 300));
      return res.status(502).json({
        error: `Gemini returned an unexpected response (HTTP ${response.status}). ` +
               `Raw: ${rawText.slice(0, 150)}`
      });
    }

    // Gemini API-level error (e.g. invalid key, quota exceeded)
    if (!response.ok || data.error) {
      const msg = data?.error?.message || `Gemini error (HTTP ${response.status})`;
      console.error('Gemini API error:', msg);
      return res.status(response.status || 500).json({ error: msg });
    }

    // Extract the generated text
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
      const safety = JSON.stringify(data?.candidates?.[0]?.safetyRatings || []);
      console.error('Empty text. Reason:', reason, 'Safety:', safety);
      return res.status(500).json({
        error: `Gemini returned empty content (stop reason: ${reason}). Try again or use a different PDF.`
      });
    }

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({
      error: `Server error: ${err.message || 'Unknown error'}`
    });
  }
}
