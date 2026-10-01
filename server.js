try { require('dotenv').config(); } catch (e) {}
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const axios = require('axios');
const admin = require('firebase-admin');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const mongoose = require('mongoose');

// Hardcoded Default Configurations (No .env file required!)
const PORT = process.env.PORT || 5000;
const API_BASE = 'https://api.chamindu.site';
const API_KEY = 'chama_api_9fec7898a703d2a4ca36aa6d87e62f87';
const FIREBASE_DATABASE_URL = 'https://website-be4c2-default-rtdb.europe-west1.firebasedatabase.app/';
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://Movie_Bot:tZGqdSzN6JaOt5ez@moviebot.bfksyk1.mongodb.net/";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Initialize MongoDB Session Engine
const SessionSchema = new mongoose.Schema({
    _id: String,
    data: String
}, { timestamps: true });

let SessionModel = null;

async function initMongoDB() {
    try {
        if (mongoose.connection.readyState === 1) return;
        await mongoose.connect(MONGO_URI);
        SessionModel = mongoose.models.BaileysSession || mongoose.model('BaileysSession', SessionSchema);
        console.log('🍃 MongoDB Cluster0 connected successfully for WhatsApp Session Persistence!');
    } catch (err) {
        console.error('MongoDB Connect Error:', err.message);
    }
}

initMongoDB().catch(() => {});

// Backup Auth Files to MongoDB
async function backupAuthToMongo() {
    try {
        await initMongoDB();
        if (!SessionModel) return;
        if (!fs.existsSync(AUTH_DIR)) return;

        const files = fs.readdirSync(AUTH_DIR);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const content = fs.readFileSync(path.join(AUTH_DIR, file), 'utf8');
                await SessionModel.updateOne({ _id: file }, { data: content }, { upsert: true });
            }
        }
        console.log('🍃 Saved Baileys WhatsApp Session Keys to MongoDB Cluster0!');
    } catch (err) {
        // Silent error
    }
}

// Restore Auth Files from MongoDB
async function restoreAuthFromMongo() {
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) return true;

        await initMongoDB();
        if (!SessionModel) return false;

        const docs = await SessionModel.find({});
        if (docs && docs.length > 0) {
            for (const doc of docs) {
                fs.writeFileSync(path.join(AUTH_DIR, doc._id), doc.data, 'utf8');
            }
            console.log(`📦 Restored Baileys WhatsApp Session Keys (${docs.length} files) from MongoDB Cluster0!`);
            return true;
        }
    } catch (err) {
        console.error('MongoDB Session Restore Error:', err.message);
    }
    return false;
}

// Combined Backup & Restore Functions
async function backupAuthSession() {
    await backupAuthToMongo();
    await backupAuthToFirebase();
}

async function restoreAuthSession() {
    const mongoRestored = await restoreAuthFromMongo();
    if (!mongoRestored) {
        await restoreAuthFromFirebase();
    }
}

// 2. Initialize Firebase Admin SDK
const LOCAL_FIREBASE_KEY = path.join(__dirname, 'firebase_credentials.json');
const PARENT_FIREBASE_KEY = path.join(__dirname, '..', 'firebase_credentials.json');
let db = null;
let rtdb = null;

try {
    let credential = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
        let serviceAccount;
        if (rawAccount.startsWith('{')) {
            serviceAccount = JSON.parse(rawAccount);
        } else {
            serviceAccount = JSON.parse(Buffer.from(rawAccount, 'base64').toString('utf8'));
        }
        credential = admin.credential.cert(serviceAccount);
    } else if (fs.existsSync(LOCAL_FIREBASE_KEY)) {
        const serviceAccount = require(LOCAL_FIREBASE_KEY);
        credential = admin.credential.cert(serviceAccount);
    } else if (fs.existsSync(PARENT_FIREBASE_KEY)) {
        const serviceAccount = require(PARENT_FIREBASE_KEY);
        credential = admin.credential.cert(serviceAccount);
    }

    if (credential) {
        admin.initializeApp({
            credential,
            databaseURL: FIREBASE_DATABASE_URL
        });
        db = admin.firestore();
        try { rtdb = admin.database(); } catch(e){}
        console.log('🔥 Firebase Admin SDK (Firestore + Realtime DB) initialized!');
    } else {
        console.warn('⚠️ Firebase initialized without admin credential. Place firebase_credentials.json in bot directory or set FIREBASE_SERVICE_ACCOUNT.');
    }
} catch (err) {
    console.error('Firebase Admin Init Error:', err.message);
}

// 3. WhatsApp Baileys Engine State & Session Persistence
let sock = null;
let qrCodeData = null;
let connectionState = 'disconnected';
let userNumber = null;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Session Sync with Firebase for Cloud Hosts (Heroku/Render/Railway Ephemeral Storage)
async function backupAuthToFirebase() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return;
        const files = fs.readdirSync(AUTH_DIR);
        const authData = {};
        for (const file of files) {
            if (file.endsWith('.json')) {
                const key = file.replace(/\./g, '__dot__');
                authData[key] = fs.readFileSync(path.join(AUTH_DIR, file), 'utf8');
            }
        }
        if (Object.keys(authData).length === 0) return;

        if (rtdb) {
            await rtdb.ref('baileys_auth_session').set(authData);
        } else if (db) {
            await db.collection('bot_settings').doc('baileys_auth_session').set(authData);
        }
    } catch (err) {
        // Silent error for optional backup
    }
}

async function restoreAuthFromFirebase() {
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) return; // Session already present locally

        let authData = null;
        if (rtdb) {
            const snap = await rtdb.ref('baileys_auth_session').once('value');
            authData = snap.val();
        } else if (db) {
            const doc = await db.collection('bot_settings').doc('baileys_auth_session').get();
            if (doc.exists) authData = doc.data();
        }

        if (authData) {
            for (const [key, value] of Object.entries(authData)) {
                const fileName = key.replace(/__dot__/g, '.');
                fs.writeFileSync(path.join(AUTH_DIR, fileName), value, 'utf8');
            }
            console.log('📦 Restored Baileys WhatsApp session from Firebase Cloud!');
        }
    } catch (err) {
        console.error('Session restore error:', err.message);
    }
}

async function clearAuthSession() {
    qrCodeData = null;
    connectionState = 'disconnected';
    userNumber = null;
    if (fs.existsSync(AUTH_DIR)) {
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch (e) {
            console.error('Error clearing auth dir:', e);
        }
    }
    try {
        await initMongoDB();
        if (SessionModel) {
            await SessionModel.deleteMany({});
            console.log('🗑️ Cleared Baileys session keys from MongoDB!');
        }
        if (rtdb) {
            await rtdb.ref('baileys_auth_session').remove();
        } else if (db) {
            await db.collection('bot_settings').doc('baileys_auth_session').delete();
        }
    } catch (e) {}
}

async function connectToWhatsApp() {
    await restoreAuthSession();

    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        mediaUploadTimeoutMs: 300000,  // 5 min timeout for large files up to 2GB
        maxMsgRetryCount: 5
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await backupAuthSession();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await qrcode.toDataURL(qr);
            connectionState = 'disconnected';
            console.log('⚡ New QR Code generated!');
        }

        if (connection === 'connecting') {
            connectionState = 'connecting';
            console.log('🔄 Connecting to WhatsApp...');
        }

        if (connection === 'open') {
            connectionState = 'connected';
            qrCodeData = null;
            userNumber = sock.user ? sock.user.id.split(':')[0] : 'Connected';
            console.log(`✅ WhatsApp Bot Connected successfully as: ${userNumber}`);
            await backupAuthSession();
            
            // Start listening to Firebase pending requests
            startFirebaseWorker();
        }

        if (connection === 'close') {
            connectionState = 'disconnected';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401);
            console.log(`❌ Connection closed. Status Code: ${statusCode}, Reconnecting: ${!isLoggedOut}`);

            if (isLoggedOut) {
                console.log('🔒 WhatsApp session invalid/logged out. Resetting auth state for fresh pairing...');
                await clearAuthSession();
                setTimeout(connectToWhatsApp, 3000);
            } else {
                setTimeout(connectToWhatsApp, 3000);
            }
        }
    });
}

connectToWhatsApp().catch(err => console.error('WA Init Error:', err));

// 3. Real-time Firebase Pending Requests Worker (Realtime DB + Firestore)
let isWorkerRunning = false;

function startFirebaseWorker() {
    if (isWorkerRunning) return;
    isWorkerRunning = true;
    console.log('🤖 Firebase Real-time Queue Worker started!');

    // Listener A: Firebase Realtime Database
    if (rtdb) {
        try {
            rtdb.ref('movie_requests').on('child_added', snapshot => {
                const reqId = snapshot.key;
                const reqData = snapshot.val();
                if (reqData && reqData.status === 'pending') {
                    if (connectionState === 'connected' && sock) {
                        processMovieRequest(reqId, reqData, 'rtdb');
                    }
                }
            });
        } catch (e) {}
    }

    // Listener B: Firestore
    if (db) {
        db.collection('movie_requests')
            .where('status', '==', 'pending')
            .onSnapshot(snapshot => {
                snapshot.docChanges().forEach(async change => {
                    if (change.type === 'added') {
                        const reqId = change.doc.id;
                        const reqData = change.doc.data();
                        if (connectionState === 'connected' && sock) {
                            await processMovieRequest(reqId, reqData, 'firestore');
                        }
                    }
                });
            }, err => {
                console.error('Worker Listener Error:', err.message);
            });
    }
}

// Process Single Movie / TV Series Request
async function processMovieRequest(reqId, reqData, dbType = 'firestore') {
    try {
        // Mark as Processing — update both RTDB and Firestore
        if (rtdb) {
            try { await rtdb.ref(`movie_requests/${reqId}`).update({ status: 'processing', processedAt: Date.now() }); } catch(_){}
        }
        if (db) {
            try { await db.collection('movie_requests').doc(reqId).update({ status: 'processing', processedAt: Date.now() }); } catch(_){}
        }

        const { phone, title, url, poster, site = 'sinhalasub', season = 'all', episode = 'all', isTv = false, quality = 'best', qualityLink = '', subtitleLang = 'auto', subLink = '' } = reqData;

        let downloads = [];
        let story = '';
        let tvSeasons = [];
        let isTvShow = isTv || url.includes('/tv/') || (site === 'moviebox' && (season !== 'all' || episode !== 'all'));

        // 1. Fetch details & links from Scraper API
        try {
            if (site === 'moviebox' && isTvShow) {
                const tvInfoUrl = `${API_BASE}/api/v1/movie/moviebox/tv/info?q=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}&api_key=${API_KEY}`;
                const tvResp = await axios.get(tvInfoUrl, { timeout: 15000 });
                const tvData = tvResp.data.data || tvResp.data || {};
                tvSeasons = tvData.seasons || [];
                story = tvData.story || tvData.description || '';
                downloads = tvData.download_links || tvData.downloads || tvData.links || tvData.qualities || [];

                if (season !== 'all' && episode !== 'all') {
                    const dlUrl = `${API_BASE}/api/v1/movie/moviebox/tv/dl?q=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}&se=${season}&ep=${episode}&api_key=${API_KEY}`;
                    const dlResp = await axios.get(dlUrl, { timeout: 15000 });
                    downloads = dlResp.data.data || dlResp.data || [];
                }
            } else if (site === 'moviebox') {
                const infoUrl = `${API_BASE}/api/v1/movie/moviebox/info?q=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}&api_key=${API_KEY}`;
                const resp = await axios.get(infoUrl, { timeout: 15000 });
                const data = resp.data.data || resp.data || {};
                downloads = data.download_links || data.downloads || data.links || data.qualities || [];
                story = data.story || data.description || '';
            } else {
                const infoUrl = `${API_BASE}/api/v1/movie/${site}/infodl?q=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}&api_key=${API_KEY}`;
                const resp = await axios.get(infoUrl, { timeout: 15000 });
                const data = resp.data.data || resp.data || {};
                downloads = data.download_links || data.downloads || data.links || data.qualities || [];
                story = data.story || data.description || '';
                if (data.seasons) tvSeasons = data.seasons;
            }
        } catch (e) {
            console.error('Scraper API Fetch error:', e.message);
        }

        // 2. Format JID
        let formattedPhone = phone.replace(/[^0-9]/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '94' + formattedPhone.substring(1);
        const jid = `${formattedPhone}@s.whatsapp.net`;

        // 3. Filter Target Downloads by User's Chosen Quality & Subtitle Language
        let targetFiles = [];
        let targetSubs = [];

        if (Array.isArray(downloads) && downloads.length > 0) {
            const videoDl = downloads.filter(d => d.quality !== 'SUB' && !(d.title && d.title.toLowerCase().includes('subtitle')));
            const subDl = downloads.filter(d => d.quality === 'SUB' || (d.title && d.title.toLowerCase().includes('subtitle')));

            // Subtitle Selection Logic
            if (subLink) {
                targetSubs = subDl.filter(d => (d.link || d.url || d.direct_link) === subLink);
            } else if (subtitleLang && subtitleLang !== 'auto' && subtitleLang !== 'none') {
                targetSubs = subDl.filter(d => (d.title || '').toLowerCase().includes(subtitleLang.toLowerCase()));
            } else if (subtitleLang === 'none') {
                targetSubs = [];
            } else {
                // Auto: Prefer English or Sinhala if available, else first sub
                const prefSub = subDl.find(d => (d.title || '').toLowerCase().includes('english')) ||
                                subDl.find(d => (d.title || '').toLowerCase().includes('sinhala')) ||
                                subDl[0];
                targetSubs = prefSub ? [prefSub] : [];
            }

            // Video Quality Selection Logic
            if (qualityLink) {
                targetFiles = videoDl.filter(d => (d.link || d.url || d.direct_link) === qualityLink);
            }
            if (targetFiles.length === 0 && quality && quality !== 'all' && quality !== 'best') {
                targetFiles = videoDl.filter(d => (d.quality || '').toLowerCase().includes(quality.toLowerCase()));
            }
            if (targetFiles.length === 0 && quality === 'all') {
                targetFiles = videoDl;
            }
            if (targetFiles.length === 0 && videoDl.length > 0) {
                targetFiles = [videoDl[0]]; // Default to best available quality
            }
        }

        // 4. Build Clean WhatsApp Info Card (NO RAW LINKS IN TEXT)
        let captionMsg = '';
        if (isTvShow && season !== 'all' && episode !== 'all') {
            captionMsg = `📺 *${title.trim()}*\n` +
                `🎬 *Season ${season} — Episode ${episode}*\n\n` +
                `📝 *Story:* ${story ? story.substring(0, 200) + '...' : 'Sinhala Subtitles & Details'}\n` +
                `📽️ *Requested Quality:* ${quality !== 'best' ? quality : (targetFiles[0]?.quality || 'Best Available')}\n` +
                `────────────────────\n` +
                `⚡ *Uploading Document File to WhatsApp...* 🚀`;
        } else {
            captionMsg = `🎬 *${title.trim()}*\n\n` +
                `📝 *Story:* ${story ? story.substring(0, 220) + '...' : 'Sinhala Subtitles & Movie Details'}\n\n` +
                `📽️ *Selected Quality:* ${quality !== 'best' ? quality : (targetFiles[0]?.quality || 'Best Available')}\n` +
                `────────────────────\n` +
                `✨ *Requested via Chama Movie Portal* 🚀`;
        }

        // Send Poster Card
        if (poster && poster.startsWith('http')) {
            await sock.sendMessage(jid, { image: { url: poster }, caption: captionMsg });
        } else {
            await sock.sendMessage(jid, { text: captionMsg });
        }

        // 5. Send Selected Video Document Files directly to WhatsApp
        for (const dl of targetFiles) {
            const directUrl = dl.direct_link || dl.url || dl.link || '';
            if (!directUrl) continue;

            const qLabel = dl.quality || dl.name || 'Video File';
            const fSizeStr = dl.size || '';

            // Parse size string to MB for comparison (e.g. "1.4 GB", "800 MB", "450 MB")
            let sizeMB = 0;
            if (fSizeStr) {
                const sizeMatch = fSizeStr.match(/([\d.]+)\s*(GB|MB|KB)/i);
                if (sizeMatch) {
                    const val = parseFloat(sizeMatch[1]);
                    const unit = sizeMatch[2].toUpperCase();
                    if (unit === 'GB') sizeMB = val * 1024;
                    else if (unit === 'MB') sizeMB = val;
                    else if (unit === 'KB') sizeMB = val / 1024;
                }
            }

            const fSizeLabel = fSizeStr ? ` (${fSizeStr})` : '';

            try {
                // Files > 2GB: Send "file too large" note only
                if (sizeMB > 2048) {
                    await sock.sendMessage(jid, {
                        text: `🎬 *${title.trim()}*\n` +
                              `🎥 *Quality:* ${qLabel}${fSizeLabel}\n\n` +
                              `⚠️ *File Size Too Large*\n` +
                              `📦 This file is *${fSizeStr}* which exceeds the 2GB WhatsApp upload limit.\n` +
                              `Please select a smaller quality (480p or 720p) and try again.\n\n` +
                              `✨ *Powered by CHAMA TECH* 🚀`
                    });
                } else {
                    // Files ≤ 2GB: Send directly as WhatsApp document
                    await sock.sendMessage(jid, {
                        document: { url: directUrl },
                        mimetype: 'video/mp4',
                        fileName: `${title.trim()} [${qLabel}].mp4`,
                        caption: `🎬 *${title.trim()}*\n🎥 *Quality:* ${qLabel}${fSizeLabel}\n\n✨ *Powered by CHAMA TECH* 🚀`
                    });
                }
            } catch (docErr) {
                // Fallback: if direct send fails, send size too large note
                console.log(`Video doc send failed:`, docErr.message);
                try {
                    await sock.sendMessage(jid, {
                        text: `⚠️ *${title.trim()}* — Document upload failed.\n` +
                              `🎥 Quality: ${qLabel}${fSizeLabel}\n` +
                              `❌ Error: File could not be uploaded to WhatsApp. Please try a smaller quality.\n\n` +
                              `✨ *Powered by CHAMA TECH* 🚀`
                    });
                } catch (fallbackErr) {
                    console.log('Fallback text send error:', fallbackErr.message);
                }
            }
        }

        // 6. Send Subtitle Document File if available
        for (const sub of targetSubs.slice(0, 1)) {
            const subUrl = sub.direct_link || sub.url || sub.link || '';
            if (!subUrl) continue;

            try {
                await sock.sendMessage(jid, {
                    document: { url: subUrl },
                    mimetype: 'application/x-subrip',
                    fileName: `${title.trim()} Subtitle.srt`,
                    caption: `📝 *Subtitle:* ${sub.title || 'Sinhala Subtitle'}\n🎬 ${title.trim()}`
                });
            } catch (subErr) {
                console.log(`Direct sub doc send error:`, subErr.message);
            }
        }


        // 5. Delete from Firebase after successful delivery (keeps queue clean)
        if (rtdb) {
            try { await rtdb.ref(`movie_requests/${reqId}`).remove(); } catch(_){}
        }
        if (db) {
            try { await db.collection('movie_requests').doc(reqId).delete(); } catch(_){}
        }

        console.log(`✅ Request ${reqId} delivered and removed from queue — +${formattedPhone}`);

    } catch (err) {
        console.error(`❌ Failed to process request ${reqId}:`, err.message);
        // On failure: mark as failed (auto-delete after 10 min)
        if (rtdb) {
            try {
                await rtdb.ref(`movie_requests/${reqId}`).update({ status: 'failed', error: err.message, failedAt: Date.now() });
                // Auto-delete failed entry after 10 minutes
                setTimeout(async () => {
                    try { await rtdb.ref(`movie_requests/${reqId}`).remove(); } catch(_){}
                }, 10 * 60 * 1000);
            } catch(_){}
        }
        if (db) {
            try { await db.collection('movie_requests').doc(reqId).update({ status: 'failed', error: err.message }); } catch(_){}
        }
    }
}

// ==========================================
// ADMIN DASHBOARD API ROUTES
// ==========================================

// Direct Movie Request API (Direct HTTP fallback from Web App)
app.post('/api/request-movie', async (req, res) => {
    try {
        const {
            phone, title, url, poster,
            site = 'sinhalasub',
            quality = 'best',
            qualityLink = '',
            subtitleLang = 'auto',
            subLink = '',
            season = 'all',
            episode = 'all',
            isTv = false
        } = req.body;

        if (!phone || !title) {
            return res.status(400).json({ success: false, error: 'Phone and title are required' });
        }

        const reqId = 'req_' + Date.now();
        const reqData = {
            phone, title, url, poster, site,
            quality, qualityLink,
            subtitleLang, subLink,
            season, episode, isTv,
            status: 'pending',
            createdAt: Date.now()
        };

        if (rtdb) rtdb.ref(`movie_requests/${reqId}`).set(reqData).catch(() => {});
        if (db) db.collection('movie_requests').doc(reqId).set(reqData).catch(() => {});

        if (connectionState === 'connected' && sock) {
            processMovieRequest(reqId, reqData, 'rtdb').catch(e => console.error(e));
        }

        res.json({ success: true, message: 'Request submitted and queued for WhatsApp delivery!', reqId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Movie API Proxy — secret token protected, blocks direct URL access
const PROXY_SECRET = 'chama_proxy_x9k2m8v3n1';
const ALLOWED_ORIGINS = [
    'https://chama-movie-web-app.pages.dev',
    'http://localhost:5173',
    'http://localhost:4173',
    'http://localhost:3000'
];

app.get('/api/proxy', async (req, res) => {
    // 1. Check Origin or Referer
    const origin = req.headers.origin || req.headers.referer || '';
    const isAllowedOrigin = ALLOWED_ORIGINS.some(o => origin.startsWith(o));

    // 2. Check secret token header
    const clientToken = req.headers['x-proxy-token'] || req.query._t;
    const isValidToken = clientToken === PROXY_SECRET;

    if (!isAllowedOrigin && !isValidToken) {
        return res.status(403).json({
            error: 'Access Denied',
            message: 'Direct API access is not allowed.'
        });
    }

    try {
        const { path: apiPath, _t, ...params } = req.query;
        if (!apiPath) return res.status(400).json({ error: 'path is required' });

        // Only allow known movie API paths
        const allowedPaths = ['/api/v1/movies/', '/api/v1/movie/'];
        const isAllowedPath = allowedPaths.some(p => apiPath.startsWith(p));
        if (!isAllowedPath) return res.status(403).json({ error: 'Forbidden path' });

        const queryStr = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const fullUrl = `${API_BASE}${apiPath}?${queryStr}&api_key=${API_KEY}`;

        const response = await axios.get(fullUrl, { timeout: 15000 });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// Get Bot Status
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        connectionState,
        connected: connectionState === 'connected',
        userNumber,
        qrCode: qrCodeData
    });
});

// Generate 8-Digit Pairing Code
app.post('/api/pair-code', async (req, res) => {
    try {
        let { phone } = req.body;
        if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });
        phone = phone.replace(/[^0-9]/g, '');

        if (!sock) {
            await connectToWhatsApp();
            await new Promise(r => setTimeout(r, 2000));
        }

        if (sock && sock.authState && sock.authState.creds && sock.authState.creds.registered) {
            return res.status(400).json({ success: false, error: 'WhatsApp is already connected/paired. Click Logout first to pair a new number.' });
        }

        const code = await sock.requestPairingCode(phone);
        console.log(`🔑 Pairing Code generated for +${phone}: ${code}`);
        res.json({ success: true, code });
    } catch (err) {
        console.error('Pair code error:', err.message);
        const errMsg = err.message || '';
        if (errMsg.includes('Closed') || errMsg.includes('closed') || errMsg.includes('not connected')) {
            await clearAuthSession();
            setTimeout(connectToWhatsApp, 1000);
            return res.status(500).json({ 
                success: false, 
                error: 'Connection was resetting. Session cleared — please click "Generate Code" again now.' 
            });
        }
        res.status(500).json({ success: false, error: err.message || 'Failed to generate pairing code' });
    }
});

// Logout / Disconnect
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            try { await sock.logout(); } catch(e) {}
        }
        await clearAuthSession();
        setTimeout(connectToWhatsApp, 1000);
        res.json({ success: true, message: 'Logged out and session cleared successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Redirect all web traffic to the Movie Web App
// Bot server URL stays hidden from public
app.get('/', (req, res) => {
    res.redirect(301, 'https://chama-movie-web-app.pages.dev/');
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// All other unknown routes → redirect to movie web app
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.redirect(301, 'https://chama-movie-web-app.pages.dev/');
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Chama WhatsApp Bot Admin Server running on port ${PORT}`);
});
