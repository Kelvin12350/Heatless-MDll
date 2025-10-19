// Dee WhatsApp AI Bot — Termux-to-Render flow with one-time upload token
import fs from "fs";
import path from "path";
import crypto from "crypto";
import fetch from "node-fetch";
import textToSpeech from "@google-cloud/text-to-speech";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

/* -------------------- Config -------------------- */
const SUPER_ADMIN_NUMBER = process.env.SUPER_ADMIN_JID || "27689828857@s.whatsapp.net";
const AUTH_FOLDER = "./auth_info";
const LINKED_FILE = "./linkedNumbers.json";
const QR_IMAGE = "./whatsapp-qr.png";
const TMP_VOICE_DIR = "./tmp_voice";

/* Token settings */
const UPLOAD_TOKEN_FILE = "./upload_token.json";
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/* -------------------- Helpers for upload token -------------------- */
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}
function saveUploadToken(obj) {
  try { fs.writeFileSync(UPLOAD_TOKEN_FILE, JSON.stringify(obj)); }
  catch (e) { console.error("Failed to save token:", e); }
}
function readUploadToken() {
  try { return JSON.parse(fs.readFileSync(UPLOAD_TOKEN_FILE, "utf8")); } catch { return null; }
}
function clearUploadToken() {
  try { if (fs.existsSync(UPLOAD_TOKEN_FILE)) fs.unlinkSync(UPLOAD_TOKEN_FILE); } catch {}
}

/* -------------------- Ensure files/dirs -------------------- */
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
if (!fs.existsSync(LINKED_FILE)) fs.writeFileSync(LINKED_FILE, "{}");
if (!fs.existsSync(TMP_VOICE_DIR)) fs.mkdirSync(TMP_VOICE_DIR, { recursive: true });

let linkedNumbers = {};
try { linkedNumbers = JSON.parse(fs.readFileSync(LINKED_FILE, "utf8")); } catch { linkedNumbers = {}; }
function saveLinkedNumbers() {
  try { fs.writeFileSync(LINKED_FILE, JSON.stringify(linkedNumbers, null, 2)); } 
  catch (e) { console.error("Failed to save linkedNumbers:", e); }
}

/* -------------------- TTS Key Setup -------------------- */
const TTS_KEY_PATH = "./google-tts-key.json";
if (process.env.RENDER_SECRET_TTS_KEY && !fs.existsSync(TTS_KEY_PATH)) {
  try { fs.writeFileSync(TTS_KEY_PATH, process.env.RENDER_SECRET_TTS_KEY); } 
  catch (err) { console.error("Failed to write TTS key:", err); }
}

/* -------------------- Express server (QR page, download/upload helpers) -------------------- */
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "50mb" }));

// In-memory QR management (prevents page-refresh from creating new QR)
let latestQR = null;
let qrLastUpdated = 0;

// SSE clients
const sseClients = [];
function broadcastEvent(eventName, data = {}) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { /* ignore broken clients */ }
  }
}

/* Main UI for scanning and auth download */
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Dee — Scan QR</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f6fa;margin:0}
      .card{background:#fff;padding:18px;border-radius:10px;box-shadow:0 8px 24px rgba(23,23,23,0.06);width:340px;text-align:center}
      img{width:300px;height:300px;object-fit:contain;border:1px solid #eee}
      .status{margin-top:12px;font-size:14px;color:#333}
      .hint{margin-top:8px;font-size:12px;color:#666}
      .btn{display:inline-block;margin-top:10px;padding:8px 12px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none}
    </style>
  </head>
  <body>
    <div class="card">
      <h3>Scan QR to connect</h3>
      <div id="qrWrap"><img id="qrImg" src="/qr.png?ts=${qrLastUpdated}" alt="QR" /></div>
      <div class="status" id="status">Waiting for QR...</div>
      <div class="hint">Open WhatsApp → Linked Devices → Link a device</div>
      <div id="downloadArea"></div>
    </div>
    <script>
      const statusEl=document.getElementById('status');
      const qrImg=document.getElementById('qrImg');
      const downloadArea=document.getElementById('downloadArea');
      const ev=new EventSource('/events');
      ev.addEventListener('qr', (e)=>{const p=JSON.parse(e.data||'{}'); qrImg.src='/qr.png?ts='+ (p.ts||Date.now()); statusEl.textContent='Scan the QR with your phone — QR is valid now.'});
      ev.addEventListener('connected', (e)=>{ statusEl.textContent='✅ Bot connected'; document.getElementById('qrWrap').style.display='none'; const link=document.createElement('a'); link.href='/download-auth'; link.className='btn'; link.textContent='Download auth bundle'; downloadArea.innerHTML=''; downloadArea.appendChild(link); });
      ev.addEventListener('cleared', ()=>{ statusEl.textContent='QR cleared. Waiting for new QR...'; document.getElementById('qrWrap').style.display=''; });
      ev.onerror=()=>console.warn('SSE error');
      fetch('/status').then(r=>r.json()).then(j=>{ if(j.connected){ statusEl.textContent='✅ Bot connected'; document.getElementById('qrWrap').style.display='none'; const link=document.createElement('a'); link.href='/download-auth'; link.className='btn'; link.textContent='Download auth bundle'; downloadArea.appendChild(link);} else if(j.hasQR){ statusEl.textContent='Scan the QR with your phone — QR is valid now.'; qrImg.src='/qr.png?ts='+ (j.qrTs || Date.now()); } else statusEl.textContent='Waiting for QR generation...' }).catch(()=>{});
    </script>
  </body>
  </html>`);
});

/* Serve QR image file */
app.get("/qr.png", (req, res) => {
  if (fs.existsSync(QR_IMAGE)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.resolve(QR_IMAGE));
  } else {
    res.status(404).send("QR not generated yet");
  }
});

/* Status endpoint */
app.get("/status", (req, res) => {
  const connected = !fs.existsSync(QR_IMAGE) && !latestQR;
  res.json({ connected, hasQR: !!latestQR, qrTs: qrLastUpdated });
});

/* SSE endpoint */
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write("\n");
  sseClients.push(res);
  req.on("close", () => { const idx = sseClients.indexOf(res); if (idx >= 0) sseClients.splice(idx, 1); });
});

/* -------------------- Auth bundle download (local use) -------------------- */
app.get("/download-auth", (req, res) => {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return res.status(404).send("No auth folder found");
    const files = fs.readdirSync(AUTH_FOLDER);
    if (!files.length) return res.status(404).send("Auth folder empty");
    const bundle = {};
    for (const f of files) {
      const fp = path.join(AUTH_FOLDER, f);
      const stat = fs.statSync(fp);
      if (stat.isFile()) bundle[f] = fs.readFileSync(fp).toString("base64");
    }
    res.setHeader('Content-Disposition', 'attachment; filename="auth_bundle.json"');
    res.json({ files: bundle });
  } catch (err) {
    console.error("download-auth error:", err);
    res.status(500).send("Failed to prepare auth bundle");
  }
});

/* -------------------- Secure upload endpoint (/upload-auth) --------------------
   - Requires Authorization: Bearer <ONE_TIME_TOKEN>
   - If you set AUTH_UPLOAD_SECRET in environment, also requires header X-Upload-Secret: <value>
   - Body: { files: { "file.json": "<base64>", ... } }
   - Writes files into AUTH_FOLDER and returns success.
   ------------------------------------------------------------------------- */
app.post("/upload-auth", (req, res) => {
  try {
    const authHeader = (req.headers.authorization || "");
    if (!authHeader.startsWith("Bearer ")) return res.status(401).send("Missing token");
    const provided = authHeader.slice(7).trim();

    const tokenObj = readUploadToken();
    if (!tokenObj || tokenObj.token !== provided || Date.now() > tokenObj.expires) {
      return res.status(403).send("Invalid or expired token");
    }

    // Optional extra secret (set AUTH_UPLOAD_SECRET in Render env for extra protection)
    if (process.env.AUTH_UPLOAD_SECRET) {
      const secret = req.headers['x-upload-secret'];
      if (!secret || secret !== process.env.AUTH_UPLOAD_SECRET) return res.status(403).send("Missing/invalid upload secret");
    }

    const body = req.body;
    if (!body || !body.files) return res.status(400).send("Missing files");
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    for (const [name, b64] of Object.entries(body.files)) {
      const fp = path.join(AUTH_FOLDER, name);
      fs.writeFileSync(fp, Buffer.from(b64, "base64"));
      console.log("Wrote auth file:", fp);
    }

    // Clear token (one-time use)
    clearUploadToken();

    return res.send("Auth uploaded — restart the service to use credentials");
  } catch (err) {
    console.error("upload-auth error:", err);
    return res.status(500).send("Failed to write auth files");
  }
});

/* Start Express server */
app.listen(PORT, () => console.log(`🌐 Web server running at http://localhost:${PORT}`));

/* -------------------- Baileys auth + socket -------------------- */
const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({ auth: state, version, printQRInTerminal: false });
sock.ev.on("creds.update", saveCreds);

/* -------------------- QR / connection handling -------------------- */
sock.ev.on("connection.update", async (update) => {
  try {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      if (qr !== latestQR) {
        latestQR = qr;
        qrLastUpdated = Date.now();

        try { qrcodeTerminal.generate(qr, { small: false }); } catch (e) {}
        try { await QRCode.toFile(QR_IMAGE, qr, { width: 800 }); console.log("✅ QR saved to", QR_IMAGE); } catch (err) { console.warn("Failed to save QR image:", err?.message || err); }

        broadcastEvent('qr', { ts: qrLastUpdated });
      } else {
        console.log("QR received but same as current; reusing existing QR.");
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected");

      // When first connected, generate one-time upload token and send it to the owner.
      try {
        const existing = readUploadToken();
        // Generate token only if none exists (avoid spamming multiple tokens)
        if (!existing) {
          const token = generateToken();
          const expires = Date.now() + TOKEN_TTL_MS;
          saveUploadToken({ token, expires });

          // Send token to owner JID
          const ownerJid = SUPER_ADMIN_NUMBER;
          const msgText = `Dee bot upload token (one-time). Use to upload auth_bundle.json within ${Math.floor(TOKEN_TTL_MS/60000)} minutes:\n\n${token}`;
          await sock.sendMessage(ownerJid, { text: msgText });
          console.log("Sent upload token to owner:", ownerJid);
        } else {
          console.log("Upload token already exists; not sending new token.");
        }
      } catch (err) {
        console.error("Failed to create/send upload token:", err);
      }

      // Clear QR and remove file so UI shows connected
      latestQR = null;
      qrLastUpdated = Date.now();
      try { if (fs.existsSync(QR_IMAGE)) fs.unlinkSync(QR_IMAGE); } catch (e) {}
      broadcastEvent('connected', { ts: Date.now() });
    }

    if (connection === "close") {
      console.log("⚠️ Connection closed", lastDisconnect?.error?.output || lastDisconnect || "");
      broadcastEvent('cleared', { ts: Date.now() });
    }
  } catch (err) { console.error("connection.update error:", err); }
});

/* -------------------- TTS client and other bot logic (unchanged) -------------------- */
let ttsClient;
try {
  const ttsOpts = fs.existsSync(TTS_KEY_PATH) ? { keyFilename: TTS_KEY_PATH } : {};
  ttsClient = new textToSpeech.TextToSpeechClient(ttsOpts);
} catch (err) { console.error("Failed to create TTS client:", err); ttsClient = null; }

async function generateVoiceMessage(text) {
  if (!ttsClient) throw new Error("TTS client not configured");
  const out = path.join(TMP_VOICE_DIR, `voice_${Date.now()}.mp3`);
  const request = { input: { text }, voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" }, audioConfig: { audioEncoding: "MP3" } };
  const [response] = await ttsClient.synthesizeSpeech(request);
  await fs.promises.writeFile(out, response.audioContent, "binary");
  return out;
}

/* -------------------- Google AI function (unchanged) -------------------- */
async function getGoogleAIReply(prompt, context = [], personality = "friendly") {
  const apiKey = process.env.GOOGLE_AI_KEY;
  const project = process.env.GOOGLE_PROJECT_ID;
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${project}/locations/us-central1/publishers/google/models/text-bison-001:predict?key=${apiKey}`;

  let personalityPrompt = { friendly: "Respond cheerfully with emojis.", sarcastic: "Respond sarcastically but witty.", formal: "Respond politely and formally." }[personality] || "";

  const fullPrompt = [...context, { role: "user", content: `${prompt}\n${personalityPrompt}` }].map(m => m.content).join("\n");
  const body = { instances: [{ content: fullPrompt }], parameters: { temperature: 0.7, maxOutputTokens: 500 } };

  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    return data?.predictions?.[0]?.content || "Sorry, I couldn't generate a response.";
  } catch (err) { console.error("Google AI error:", err); return "Sorry, I couldn't process that message."; }
}

/* -------------------- Menu, group handlers, messages.upsert (same as your logic) -------------------- */
/* Paste or keep your existing message handlers and commands here.
   For brevity I'm keeping behavior identical to what you provided earlier.
   Example: sendButtonMenu, groupContext, messages.upsert handling, etc.
   (Make sure to paste your original handlers here unchanged if you removed them.) */

/* --- Minimal example to verify bot responds (replace with your previous full handlers) --- */

async function sendButtonMenu(groupId, senderId) {
  const owner = senderId === SUPER_ADMIN_NUMBER;
  const general = { title: "General Commands", rows: [
    { title: "Help", rowId: "@dee help", description: "Show help menu" },
    { title: "Talk to Dee", rowId: "@dee talk", description: "Chat with Dee" },
    { title: "Link Phone", rowId: "@dee link <your-number>", description: "Link your phone number" }
  ]};
  const ownerSec = { title: "Owner Commands", rows: [
    { title: "Tag All Members", rowId: "ai tagall members", description: "Tag everyone" },
    { title: "Reset Group Context", rowId: "@dee reset group", description: "Clear memory" },
    { title: "Set Personality Friendly", rowId: "@dee set personality friendly", description: "Friendly" }
  ]};
  const sections = [general]; if (owner) sections.push(ownerSec);
  try { await sock.sendMessage(groupId, { text: "🎛️ @Dee Command Menu\nTap a command below:", buttonText: "Show Commands", sections, headerType: 1 }); } catch(e){ console.error(e); }
}

const groupContext = {}, groupPersonality = {};
sock.ev.on("group-participants.update", async ({ action, participants, id }) => {
  try { 
    if (action === "add" && participants?.includes(sock.user?.id)) {
      groupContext[id] = []; groupPersonality[id] = "friendly";
      await sock.sendMessage(id, { text: `👋 Hi! I'm @Dee — mention me with "@Dee" to chat.` });
      await sendButtonMenu(id, SUPER_ADMIN_NUMBER);
    }
  } catch (err) { console.error("group update error:", err); }
});

sock.ev.on("messages.upsert", async ({ messages }) => {
  try {
    const msg = messages?.[0]; if (!msg?.message) return;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text; if (!text) return;
    const sender = msg.key?.participant, groupId = msg.key?.remoteJid; if (!sender || !groupId) return;
    if (!groupContext[groupId]) groupContext[groupId] = []; if (!groupPersonality[groupId]) groupPersonality[groupId] = "friendly";
    const owner = sender === SUPER_ADMIN_NUMBER;

    if (["@dee help","@dee talk"].includes(text.toLowerCase())) return sendButtonMenu(groupId, sender);

    if (text.toLowerCase().startsWith("@dee link")) {
      const phone = text.split(" ")[2]; 
      if (!phone) return sock.sendMessage(groupId,{text:"Please provide your phone number: @Dee link <your-number>"});
      linkedNumbers[sender]=phone; saveLinkedNumbers();
      return sock.sendMessage(groupId,{text:`✅ Your number ${phone} is linked!`});
    }

    if (text.toLowerCase().includes("@dee")) {
      const userMessage = text.replace("@Dee", "").trim();
      groupContext[groupId].push({ role: "user", content: userMessage });
      if (groupContext[groupId].length > 10) groupContext[groupId].shift();

      const aiReply = await getGoogleAIReply(userMessage, groupContext[groupId], groupPersonality[groupId]);
      groupContext[groupId].push({ role: "assistant", content: aiReply });
      await sock.sendMessage(groupId, { text: aiReply });

      if (Math.random() < 0.4 && ttsClient) {
        try {
          const voiceFile = await generateVoiceMessage(aiReply);
          if (fs.existsSync(voiceFile)) {
            await sock.sendMessage(groupId, { audio: fs.createReadStream(voiceFile), mimetype: "audio/mpeg" });
            fs.unlinkSync(voiceFile);
          }
        } catch (err) { console.error("TTS send error:", err); }
      }
    }

  } catch (err) { console.error("messages.upsert handler error:", err); }
});

console.log("🤖 @Dee Bot started! Open the web UI and scan the QR if needed (http://localhost:3000).");
