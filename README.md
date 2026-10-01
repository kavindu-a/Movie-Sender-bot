# 🤖 Chama WhatsApp Movie Bot Server

Automated WhatsApp Movie & Series delivery bot + API Proxy built with **Node.js, Express, Baileys, MongoDB, and Firebase Realtime Database**.

---

## ⚡ Quick Start (Local PC / VPS)

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start Server**:
   ```bash
   npm start
   ```

3. **Link WhatsApp**:
   - Open browser: `http://localhost:5000/admin`
   - Enter WhatsApp Phone Number (e.g. `94771234567`)
   - Click **Generate Pairing Code**
   - Open WhatsApp on your phone: **Settings > Linked Devices > Link with phone number** and enter the 8-digit code.

---

## ☁️ 24/7 Cloud Deployment (Heroku / Render / Railway)

1. Push this folder to a GitHub Repository.
2. Link to Heroku / Render Web Service.
3. Configure Environment Variables (Optional - built-in defaults are provided):
   - `PORT`: (Auto-set by host or `5000`)
   - `API_KEY`: `chama_api_c82b12fffda71170b553f662d39426ec`
   - `MONGO_URI`: MongoDB connection string for session persistence.
4. Open `https://your-bot.herokuapp.com/admin` to pair your WhatsApp account.

---

## 🔒 Endpoints & Security
- `/admin` : Web Pairing Dashboard (Password-free / restricted)
- `/api/proxy` : Scraper API Proxy (Requires `X-Proxy-Token: chama_proxy_x9k2m8v3n1`)
- `/api/request-movie` : Movie request receiver from Frontend
- `/` : Public root redirects to Movie Web App
