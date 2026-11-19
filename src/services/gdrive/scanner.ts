import fs from 'fs';
import path from 'path';
import { config } from '../../config/env.js';
import { stripCategoryFromTitle } from '../../config/constants.js';

export interface GDriveVideoItem {
  id: string;
  name: string;
  cleanTitle: string;
  sizeBytes: number;
  sizeMb: string;
  mimeType: string;
  modifiedTime: Date;
  isPosted: boolean;
  isLocalFallback?: boolean;
  webViewLink?: string;
}

export interface GDriveScanResult {
  folderId: string;
  totalVideos: number;
  postedCount: number;
  pendingCount: number;
  videos: GDriveVideoItem[];
  error?: string;
}

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

export class GoogleDriveScanner {
  private cachedOAuthToken: string | null = null;
  private tokenExpiresAt: number = 0;

  public extractFolderId(input: string): string {
    const trimmed = (input || '').trim();
    if (!trimmed) return '';

    if (/^(https?:\/\/|www\.|drive\.google\.com)/i.test(trimmed)) {
      const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_\-]+)/i);
      if (folderMatch && folderMatch[1]) return folderMatch[1];

      const dMatch = trimmed.match(/\/d\/([a-zA-Z0-9_\-]+)/i);
      if (dMatch && dMatch[1]) return dMatch[1];

      const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_\-]+)/i);
      if (idParamMatch && idParamMatch[1]) return idParamMatch[1];

      return '';
    }

    return trimmed.replace(/[^a-zA-Z0-9_\-]/g, '') || trimmed;
  }

  public cleanVideoTitle(filename: string): string {
    let title = filename;
    const extIdx = title.lastIndexOf('.');
    if (extIdx !== -1) {
      title = title.substring(0, extIdx);
    }
    title = title.replace(/#[a-zA-Z0-9_\u0980-\u09FF]+/g, '').trim();
    title = title.replace(/^[\d\-_.]+\s*[-_.]*\s*/, '');
    title = stripCategoryFromTitle(title);
    title = title.replace(/[-_.]+/g, ' ').trim();
    if (title === title.toLowerCase()) {
      title = title.replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return title || filename;
  }

  public extractHashtags(text: string): string[] {
    if (!text) return [];
    const matches = text.match(/#([a-zA-Z0-9_\u0980-\u09FF]+)/g);
    return matches ? matches.map((m) => m.trim()) : [];
  }

  public async getOAuthToken(): Promise<string | null> {
    if (this.cachedOAuthToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.cachedOAuthToken;
    }

    const clientId = config.GOOGLE_CLIENT_ID;
    const clientSecret = config.GOOGLE_CLIENT_SECRET;
    const refreshToken = config.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      return null;
    }

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.warn(`[GoogleDriveScanner] OAuth refresh failed (${res.status}): ${err}`);
        return null;
      }

      const data = (await res.json()) as any;
      if (data.access_token) {
        this.cachedOAuthToken = data.access_token;
        this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        return this.cachedOAuthToken;
      }
    } catch (err: any) {
      console.warn(`[GoogleDriveScanner] Error getting OAuth token: ${err.message}`);
    }

    return null;
  }

  public async scanFolder(
    folderInput: string,
    postedVideoIds: string[] = []
  ): Promise<GDriveScanResult> {
    const cleanFolderId = this.extractFolderId(folderInput || config.GDRIVE_FOLDER_ID || '');
    if (!cleanFolderId) {
      return {
        folderId: '',
        totalVideos: 0,
        postedCount: 0,
        pendingCount: 0,
        videos: [],
        error: 'Google Drive folder ID is missing or invalid.',
      };
    }

    const videoMap = new Map<string, GDriveVideoItem>();

    // 1. Scan remote Drive folder if credentials exist
    const oauthToken = await this.getOAuthToken();
    const apiKey = config.GOOGLE_DRIVE_API_KEY;

    if (oauthToken || apiKey) {
      try {
        const queryParams = new URLSearchParams({
          q: `'${cleanFolderId}' in parents and trashed = false`,
          fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
          orderBy: 'createdTime asc',
          pageSize: '100',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });

        if (!oauthToken && apiKey) {
          queryParams.append('key', apiKey);
        }

        const headers: Record<string, string> = {};
        if (oauthToken) {
          headers['Authorization'] = `Bearer ${oauthToken}`;
        }

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${queryParams.toString()}`, {
          headers,
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          const files = data.files || [];

          for (const file of files) {
            const isVideoMime = file.mimeType?.startsWith('video/');
            const hasVideoExt = VIDEO_EXTENSIONS.some((ext) => file.name?.toLowerCase().endsWith(ext));
            if (!isVideoMime && !hasVideoExt) continue;

            const sizeBytes = parseInt(file.size || '0', 10);
            const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
            const isPosted =
              postedVideoIds.includes(file.id) ||
              postedVideoIds.includes(file.name);

            videoMap.set(file.id, {
              id: file.id,
              name: file.name,
              cleanTitle: this.cleanVideoTitle(file.name),
              sizeBytes,
              sizeMb,
              mimeType: file.mimeType || 'video/mp4',
              modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : new Date(),
              isPosted,
              webViewLink: file.webViewLink,
              isLocalFallback: false,
            });
          }
        }
      } catch (err: any) {
        console.warn(`[GoogleDriveScanner] Drive API scan note: ${err.message}`);
      }
    }

    // 2. Scan local fallback folder: data/gdrive_folders/<cleanFolderId>/
    const localDir = path.join(config.DATA_DIR, 'gdrive_folders', cleanFolderId);
    if (fs.existsSync(localDir)) {
      try {
        const localFiles = fs.readdirSync(localDir);
        for (const filename of localFiles) {
          const hasVideoExt = VIDEO_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));
          if (!hasVideoExt) continue;

          const localId = `local_${Buffer.from(filename).toString('hex').slice(0, 16)}`;
          if (!videoMap.has(localId)) {
            const fullPath = path.join(localDir, filename);
            const stat = fs.statSync(fullPath);
            const sizeBytes = stat.size;
            const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
            const isPosted =
              postedVideoIds.includes(localId) ||
              postedVideoIds.includes(filename);

            videoMap.set(localId, {
              id: localId,
              name: filename,
              cleanTitle: this.cleanVideoTitle(filename),
              sizeBytes,
              sizeMb,
              mimeType: 'video/mp4',
              modifiedTime: stat.mtime,
              isPosted,
              isLocalFallback: true,
            });
          }
        }
      } catch (fsErr: any) {
        console.warn(`[GoogleDriveScanner] Local folder scan note: ${fsErr.message}`);
      }
    }

    const videos = Array.from(videoMap.values());
    // Sort oldest first (FIFO queue)
    videos.sort((a, b) => a.modifiedTime.getTime() - b.modifiedTime.getTime());

    const postedCount = videos.filter((v) => v.isPosted).length;
    const pendingCount = videos.length - postedCount;

    return {
      folderId: cleanFolderId,
      totalVideos: videos.length,
      postedCount,
      pendingCount,
      videos,
    };
  }

  public async downloadVideoBuffer(
    video: GDriveVideoItem,
    folderId: string
  ): Promise<Buffer> {
    const cleanFolderId = this.extractFolderId(folderId || config.GDRIVE_FOLDER_ID || '');

    // 1. Check local file copy first
    const candidatePaths = [
      path.join(config.DATA_DIR, 'gdrive_folders', cleanFolderId, video.name),
      path.join(config.DATA_DIR, 'rendered', video.name),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p);
      }
    }

    // 2. Download from Drive API v3
    const oauthToken = await this.getOAuthToken();
    const apiKey = config.GOOGLE_DRIVE_API_KEY;
    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${video.id}?alt=media&supportsAllDrives=true`;

    const headers: Record<string, string> = {};
    if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;

    const url = !oauthToken && apiKey ? `${downloadUrl}&key=${apiKey}` : downloadUrl;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      throw new Error(`Failed to download video from Google Drive (${res.status} ${res.statusText})`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
