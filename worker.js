// Documenti di casa — Cloudflare Worker (API). Il frontend è in public/index.html
const MODEL = "gemini-2.5-flash"; // modello gratuito di Google; se un giorno non risponde, cambia solo questo nome
const CATEGORIES = ["Assicurazioni", "Contratti e utenze", "Auto", "Bollette", "Documenti personali", "Salute", "Fisco", "Casa", "Altro"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Chiamata a Gemini. "content" è una stringa oppure una lista di parti (testo / file inline).
async function claude(env, content, system, maxTokens = 4000) {
  const parts = typeof content === "string" ? [{ text: content }] : content;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }
  );
  if (!r.ok) throw new Error("Errore Gemini API: " + r.status + " " + (await r.text()));
  const data = await r.json();
  const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!out) throw new Error("Risposta vuota da Gemini");
  return out;
}

function authorized(request, env) {
  const h = request.headers.get("authorization") || "";
  return env.APP_PASSWORD && h === "Bearer " + env.APP_PASSWORD;
}

async function analyze(env, file, buf) {
  const today = new Date().toISOString().slice(0, 10);
  const system =
    "Sei un assistente che cataloga documenti di casa di una persona italiana. Rispondi SOLO con JSON valido, senza testo extra né backtick.";
  const instruction =
    `Oggi è ${today}. Analizza il documento e restituisci un JSON con queste chiavi:\n` +
    `- "title": titolo breve e chiaro (es. "Polizza auto Generali")\n` +
    `- "category": una tra ${JSON.stringify(CATEGORIES)}\n` +
    `- "summary": riassunto di 2-3 frasi con i dettagli chiave (intestatario, importi, numeri di polizza/contratto, fornitore)\n` +
    `- "content": il testo completo del documento trascritto (massimo circa 15000 caratteri)\n` +
    `- "deadlines": lista di scadenze/date rilevanti future o ricorrenti, ciascuna {"date":"YYYY-MM-DD","description":"cosa scade"}. Se manca il giorno, usa l'ultimo giorno del mese. Lista vuota se non ce ne sono.`;

  const mime = file.type || "application/octet-stream";
  let blocks;
  if (mime === "application/pdf" || mime.startsWith("image/")) {
    blocks = [
      { inline_data: { mime_type: mime, data: toBase64(buf) } },
      { text: instruction },
    ];
  } else {
    const text = new TextDecoder().decode(buf).slice(0, 60000);
    blocks = [{ text: instruction + "\n\nDOCUMENTO:\n" + text }];
  }

  const raw = await claude(env, blocks, system, 6000);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return JSON.parse(raw.slice(start, end + 1));
}

async function handleUpload(request, env) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "Nessun file" }, 400);
  const buf = await file.arrayBuffer();
  const id = crypto.randomUUID();

  let info;
  try {
    info = await analyze(env, file, buf);
  } catch (e) {
    info = { title: file.name, category: "Altro", summary: "Analisi automatica non riuscita.", content: "", deadlines: [] };
  }

  await env.FILES.put(id, buf, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  await env.DB.prepare(
    "INSERT INTO docs (id, filename, mime, title, category, summary, content, created_at) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(
      id,
      file.name,
      file.type || "application/octet-stream",
      info.title || file.name,
      CATEGORIES.includes(info.category) ? info.category : "Altro",
      info.summary || "",
      (info.content || "").slice(0, 20000),
      new Date().toISOString()
    )
    .run();

  for (const d of info.deadlines || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d.date || "")) {
      await env.DB.prepare("INSERT INTO deadlines (doc_id, date, description) VALUES (?,?,?)")
        .bind(id, d.date, d.description || "")
        .run();
    }
  }
  return json({ id, title: info.title, deadlines: info.deadlines || [] });
}

async function listDocs(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  let rows;
  if (q) {
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    rows = await env.DB.prepare(
      "SELECT id, title, category, summary, filename, created_at FROM docs WHERE title LIKE ?1 OR summary LIKE ?1 OR content LIKE ?1 OR category LIKE ?1 ORDER BY created_at DESC LIMIT 100"
    )
      .bind(like)
      .all();
  } else {
    rows = await env.DB.prepare(
      "SELECT id, title, category, summary, filename, created_at FROM docs ORDER BY created_at DESC LIMIT 200"
    ).all();
  }
  return json(rows.results);
}

async function listDeadlines(env) {
  const rows = await env.DB.prepare(
    "SELECT d.id, d.date, d.description, d.doc_id, docs.title FROM deadlines d JOIN docs ON docs.id = d.doc_id WHERE d.date >= date('now','-30 days') ORDER BY d.date ASC LIMIT 200"
  ).all();
  return json(rows.results);
}

async function ask(request, env) {
  const { question, history = [] } = await request.json();
  if (!question) return json({ error: "Domanda mancante" }, 400);

  const docs = (await env.DB.prepare("SELECT id, title, category, summary, content FROM docs").all()).results;
  const dls = (await env.DB.prepare("SELECT doc_id, date, description FROM deadlines ORDER BY date").all()).results;

  const words = question.toLowerCase().split(/[^a-zà-ú0-9]+/).filter((w) => w.length > 3);
  const scored = docs
    .map((d) => {
      const hay = (d.title + " " + d.category + " " + d.summary + " " + d.content).toLowerCase();
      return { d, score: words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
    })
    .sort((a, b) => b.score - a.score);
  const top = scored.filter((x) => x.score > 0).slice(0, 5).map((x) => x.d);

  const index = docs
    .map((d) => {
      const own = dls.filter((x) => x.doc_id === d.id).map((x) => `${x.date}: ${x.description}`).join("; ");
      return `[${d.id}] ${d.title} (${d.category}) — ${d.summary}${own ? " | Scadenze: " + own : ""}`;
    })
    .join("\n");
  const full = top.map((d) => `=== ${d.title} [${d.id}] ===\n${d.content.slice(0, 8000)}`).join("\n\n");

  const today = new Date().toISOString().slice(0, 10);
  const system =
    `Sei l'assistente dell'archivio personale di documenti di casa. Oggi è ${today}. Rispondi in italiano, in modo breve e preciso, usando SOLO i documenti forniti. ` +
    `Se l'informazione non c'è, dillo chiaramente. Cita sempre il titolo del documento da cui prendi i dati. Per le scadenze indica la data e quanti giorni mancano.`;
  const histText = history.slice(-6).map((m) => `${m.role === "user" ? "Utente" : "Assistente"}: ${m.text}`).join("\n");
  const content =
    `INDICE DOCUMENTI:\n${index || "(archivio vuoto)"}\n\nTESTI COMPLETI PIÙ RILEVANTI:\n${full || "(nessuno)"}\n\n` +
    (histText ? `CONVERSAZIONE PRECEDENTE:\n${histText}\n\n` : "") +
    `DOMANDA: ${question}`;

  const answer = await claude(env, content, system, 1500);
  return json({ answer, sources: top.map((d) => ({ id: d.id, title: d.title })) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (!authorized(request, env) && !(path.startsWith("/api/file/") && url.searchParams.get("k") === env.APP_PASSWORD)) {
      return json({ error: "Non autorizzato" }, 401);
    }

    try {
      if (path === "/api/ping") return json({ ok: true });
      if (path === "/api/upload" && request.method === "POST") return await handleUpload(request, env);
      if (path === "/api/docs" && request.method === "GET") return await listDocs(url, env);
      if (path === "/api/deadlines" && request.method === "GET") return await listDeadlines(env);
      if (path === "/api/ask" && request.method === "POST") return await ask(request, env);

      const m = path.match(/^\/api\/file\/([\w-]+)$/);
      if (m && request.method === "GET") {
        const obj = await env.FILES.get(m[1]);
        if (!obj) return json({ error: "Non trovato" }, 404);
        return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream" } });
      }

      const del = path.match(/^\/api\/docs\/([\w-]+)$/);
      if (del && request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM deadlines WHERE doc_id = ?").bind(del[1]).run();
        await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(del[1]).run();
        await env.FILES.delete(del[1]);
        return json({ ok: true });
      }
      return json({ error: "Non trovato" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};


