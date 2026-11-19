import fs from 'fs';
import path from 'path';
import { GoogleDriveScanner } from './scanner.js';
import { config } from '../../config/env.js';

export class GoogleDriveCleaner {
  private scanner: GoogleDriveScanner;

  constructor() {
    this.scanner = new GoogleDriveScanner();
  }

  public async deleteVideo(
    fileId: string,
    filename: string,
    folderId: string,
    action: 'trash' | 'permanent' = 'trash'
  ): Promise<{ success: boolean; action: string; error?: string }> {
    const cleanFolderId = this.scanner.extractFolderId(folderId || config.GDRIVE_FOLDER_ID || '');

    // 1. Remove local fallback file if exists
    if (filename && cleanFolderId) {
      const localFile = path.join(config.DATA_DIR, 'gdrive_folders', cleanFolderId, filename);
      if (fs.existsSync(localFile)) {
        try {
          fs.unlinkSync(localFile);
          console.log(`✓ [GoogleDriveCleaner] Cleaned up local file: ${localFile}`);
        } catch {}
      }
    }

    if (fileId.startsWith('local_')) {
      return { success: true, action: 'local_cleanup' };
    }

    // 2. Remove from Google Drive
    const oauthToken = await this.scanner.getOAuthToken();
    if (!oauthToken) {
      return { success: false, action, error: 'No Google OAuth token available for file deletion.' };
    }

    try {
      if (action === 'trash') {
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${oauthToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ trashed: true }),
          }
        );
        if (res.ok) {
          return { success: true, action: 'trash' };
        }
        const err = await res.text();
        return { success: false, action, error: err };
      } else {
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${oauthToken}` },
          }
        );
        if (res.ok || res.status === 204) {
          return { success: true, action: 'permanent' };
        }
        const err = await res.text();
        return { success: false, action, error: err };
      }
    } catch (err: any) {
      return { success: false, action, error: err.message };
    }
  }
}
