import { config } from '../../config/env.js';

export interface TelegramPublishOptions {
  videoBuffer?: Buffer;
  caption: string;
  title?: string;
  chatId?: string;
  isDryRun?: boolean;
}

export interface TelegramPublishResult {
  success: boolean;
  messageId?: number | string;
  chatId: string;
  error?: string;
}

export class TelegramPublisher {
  private botToken?: string;
  private defaultChatId?: string;

  constructor(botToken?: string, defaultChatId?: string) {
    this.botToken = botToken || config.TELEGRAM_BOT_TOKEN;
    this.defaultChatId = defaultChatId || config.TELEGRAM_CHANNEL_ID || config.TELEGRAM_CHAT_ID;
  }

  /**
   * Publishes a vertical Reel video directly to a Telegram Channel or Group.
   * Uses native fetch and multipart/form-data with 1024-char caption safety truncation.
   */
  public async publishVideo(options: TelegramPublishOptions): Promise<TelegramPublishResult> {
    const token = this.botToken || config.TELEGRAM_BOT_TOKEN;
    const targetChat = options.chatId || this.defaultChatId;

    if (!token || !targetChat) {
      return {
        success: false,
        chatId: targetChat || '',
        error: 'Telegram BOT token or target Chat/Channel ID is not configured.',
      };
    }

    const isDryRun = options.isDryRun ?? config.DRY_RUN;
    if (isDryRun) {
      console.log(`[TelegramPublisher - DRY RUN] Simulated video upload to Telegram (${targetChat}):`);
      console.log(`  Title: ${options.title || 'Untitled'}`);
      console.log(`  Caption: ${options.caption.substring(0, 80)}...`);
      return {
        success: true,
        messageId: `dry_run_${Date.now()}`,
        chatId: targetChat,
      };
    }

    if (!options.videoBuffer || options.videoBuffer.length === 0) {
      return {
        success: false,
        chatId: targetChat,
        error: 'Video buffer is empty or missing.',
      };
    }

    try {
      console.log(
        `[TelegramPublisher] ✈️ Uploading video (${options.videoBuffer.length} bytes) to Telegram (${targetChat})...`
      );

      // Telegram caption limit is 1024 characters
      const cleanCaption = (options.caption || '').trim().slice(0, 1020);

      const formData = new FormData();
      formData.append('chat_id', targetChat);
      formData.append('caption', cleanCaption);
      formData.append('supports_streaming', 'true');

      // Create a Blob from the Node Buffer
      const videoBlob = new Blob([options.videoBuffer], { type: 'video/mp4' });
      formData.append('video', videoBlob, 'reel.mp4');

      const url = `https://api.telegram.org/bot${token}/sendVideo`;
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      const data = (await response.json()) as any;

      if (!response.ok || !data.ok) {
        const errMsg = data.description || `HTTP ${response.status}: ${response.statusText}`;
        console.error(`[TelegramPublisher] Telegram API error:`, errMsg);
        return {
          success: false,
          chatId: targetChat,
          error: errMsg,
        };
      }

      const msgId = data.result?.message_id;
      console.log(`✓ [TelegramPublisher] Video published to Telegram! Message ID: ${msgId}`);
      return {
        success: true,
        messageId: msgId,
        chatId: targetChat,
      };
    } catch (err: any) {
      console.error(`[TelegramPublisher] Network error uploading to Telegram:`, err.message);
      return {
        success: false,
        chatId: targetChat,
        error: err.message,
      };
    }
  }

  /**
   * Sends a rich announcement card with links to social channels
   */
  public async sendAnnouncement(options: {
    title: string;
    caption?: string;
    fbUrl?: string;
    ytUrl?: string;
    newsUrl?: string;
    chatId?: string;
  }): Promise<TelegramPublishResult> {
    const token = this.botToken || config.TELEGRAM_BOT_TOKEN;
    const targetChat = options.chatId || this.defaultChatId;

    if (!token || !targetChat) {
      return {
        success: false,
        chatId: targetChat || '',
        error: 'Telegram BOT token or target Chat ID not configured.',
      };
    }

    const lines = [
      `📰 *${this.escapeMarkdown(options.title)}*`,
      '',
      options.caption ? this.escapeMarkdown(options.caption.slice(0, 300)) : '',
      '',
      options.fbUrl ? `📘 [Watch on Facebook Reels](${options.fbUrl})` : '',
      options.ytUrl ? `📺 [Watch on YouTube Shorts](${options.ytUrl})` : '',
      options.newsUrl ? `🌐 [Read Full Article](${options.newsUrl})` : '',
      `⏰ ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChat,
          text: lines,
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        }),
      });

      const data = (await res.json()) as any;
      if (!res.ok || !data.ok) {
        return { success: false, chatId: targetChat, error: data.description };
      }

      return { success: true, messageId: data.result?.message_id, chatId: targetChat };
    } catch (err: any) {
      return { success: false, chatId: targetChat, error: err.message };
    }
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
  }
}
