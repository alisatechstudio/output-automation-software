# ⚡ Output Automation
> **Stage 2 Microservice: Google Drive Folder -> Facebook / YouTube / TikTok / Telegram**

---

## 🎯 Purpose & Responsibilities
This is a standalone Node.js application dedicated exclusively to **Output Automation**:
1. **Google Drive Scanner**: Scans configured Google Drive folder(s) for pending video reels (`.mp4`, `.mov`, `.webm`), operating as a FIFO queue (oldest-first strategy) with local fallback support.
2. **Multi-Platform Publisher**:
   - **Facebook Page (Reels)**: 3-phase resumable video upload via Meta Graph API v21.0.
   - **High-CTR First Comment**: Automatically publishes a first comment containing the news article link to drive real website traffic.
   - **Facebook Groups & Stories**: Optional cross-sharing to connected Facebook Groups and Page Stories.
   - **YouTube Shorts**: Resumable video upload via YouTube Data API v3 with synthetic media disclosure and viral tags.
   - **TikTok**: Direct video upload via TikTok Content Posting API.
   - **Telegram Channel / Group**: Direct video post (`sendVideo`) with caption & hashtags, or announcement card (`sendMessage`) to Telegram channels or groups.
3. **Google Drive Auto-Cleanup**: Once successfully published to social networks, automatically deletes or trashes the video from the Google Drive folder to prevent repeat postings.
4. **Audit Logging & Deduplication**: Records publication logs (`reel_logs`, `youtube_upload_logs`, `tiktok_upload_logs`, `telegram_upload_logs`) in MongoDB.

---

## 🚀 Quick Start

### 1. Installation
```bash
cd output-automation
pnpm install
```

### 2. Environment Setup
Copy `.env.example` to `.env` and configure your credentials:
```bash
cp .env.example .env
```
Key settings:
- `MONGODB_URI`: Shared MongoDB instance for state synchronization
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`: Google Cloud credentials to read & delete videos from Google Drive
- `GDRIVE_FOLDER_ID`: Source Google Drive folder ID
- `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN`: Meta Facebook Page credentials
- `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`: YouTube Shorts credentials
- `TIKTOK_ACCESS_TOKEN`: TikTok credentials
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`: Telegram Bot API token and target channel/group
- `PORT`: Server port (default: 3002)

### 3. Running

```bash
# Development (with hot-reload)
pnpm dev

# Build TypeScript
pnpm build

# Production Start
pnpm start

# Publish next due video immediately from CLI
pnpm publish-now
```

---

## 🌐 API & Webhook Endpoints
- `GET /health` or `GET /`: Healthcheck & active platforms status
- `POST /api/cron/output` (or `GET /api/cron/output`): Scans Drive folder and broadcasts the oldest reel to all configured platforms. Compatible with **cron-job.org** or Vercel cron.
- `POST /api/publish-now`: Manually triggers immediate publication of the next pending reel.
- `GET /api/channels`: Lists all configured Google Drive-to-Social channel mappings.
- `GET /api/logs`: View publishing history across Facebook, YouTube, TikTok, and Telegram.
- `GET /api/status`: Lifetime publish counters and queue status.
