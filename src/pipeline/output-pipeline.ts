import crypto from 'crypto';
import type { Db } from 'mongodb';
import { getDatabase, isDbConnected, initDatabase } from '../db/index.js';
import {
  GDriveReelConfig,
  FacebookPage,
  YouTubeChannel,
  ReelLog,
  YouTubeUploadLog,
  TikTokUploadLog,
  TelegramUploadLog,
  NewsArticle,
} from '../db/schema.js';
import { GoogleDriveScanner, GDriveVideoItem } from '../services/gdrive/scanner.js';
import { GoogleDriveCleaner } from '../services/gdrive/cleaner.js';
import { FacebookGraphClient } from '../publishers/facebook/client.js';
import { GroupShareService } from '../publishers/facebook/group-share.js';
import { YouTubeClient } from '../publishers/youtube/client.js';
import { TikTokClient } from '../publishers/tiktok/client.js';
import { TelegramPublisher } from '../publishers/telegram/client.js';
import { generateGDriveReelHashtags, isEnglishText } from '../config/constants.js';
import { config } from '../config/env.js';

export interface ChannelPublishResult {
  channelId: string;
  channelName: string;
  videoTitle?: string;
  filename?: string;
  publishedTo: {
    facebook?: { success: boolean; videoId?: string; postId?: string; commentId?: string; error?: string };
    youtube?: { success: boolean; videoId?: string; videoUrl?: string; error?: string };
    tiktok?: { success: boolean; publishId?: string; error?: string };
    telegram?: { success: boolean; messageId?: number | string; error?: string };
  };
  deletedFromDrive?: boolean;
  error?: string;
}

export interface OutputCronResult {
  success: boolean;
  timestamp: string;
  durationMs: number;
  channelsProcessed: number;
  totalVideosPublished: number;
  results: ChannelPublishResult[];
  error?: string;
}

export class OutputPipelineService {
  private scanner: GoogleDriveScanner;
  private cleaner: GoogleDriveCleaner;
  private fbClient: FacebookGraphClient;
  private groupShareService: GroupShareService;
  private tikTokClient: TikTokClient;
  private telegramPublisher: TelegramPublisher;
  private activeFolders: Set<string> = new Set<string>();
  private activeChannels: Set<string> = new Set<string>();
  private isGlobalRunning: boolean = false;

  constructor() {
    this.scanner = new GoogleDriveScanner();
    this.cleaner = new GoogleDriveCleaner();
    this.fbClient = new FacebookGraphClient();
    this.groupShareService = new GroupShareService(this.fbClient);
    this.tikTokClient = new TikTokClient();
    this.telegramPublisher = new TelegramPublisher();
  }

  public getScanner(): GoogleDriveScanner {
    return this.scanner;
  }

  public getFbClient(): FacebookGraphClient {
    return this.fbClient;
  }

  public getTelegramPublisher(): TelegramPublisher {
    return this.telegramPublisher;
  }

  public isJobRunning(folderId?: string): boolean {
    if (folderId) {
      const clean = this.scanner.extractFolderId(folderId) || folderId.trim().toLowerCase();
      return this.activeFolders.has(clean) || this.isGlobalRunning;
    }
    return this.isGlobalRunning || this.activeFolders.size > 0 || this.activeChannels.size > 0;
  }

  public async runOutputCron(options?: {
    channelId?: string;
    folderId?: string;
    pageId?: string;
    force?: boolean;
  }): Promise<OutputCronResult> {
    const startTime = Date.now();
    const folderLockKey = options?.folderId
      ? (this.scanner.extractFolderId(options.folderId) || options.folderId.trim().toLowerCase())
      : null;
    const channelLockKey = options?.channelId?.trim() || null;

    if (!options?.force) {
      if (folderLockKey) {
        if (this.activeFolders.has(folderLockKey) || this.isGlobalRunning) {
          return {
            success: false,
            timestamp: new Date().toISOString(),
            durationMs: 0,
            channelsProcessed: 0,
            totalVideosPublished: 0,
            results: [],
            error: `Output pipeline for folder "${folderLockKey}" is already in progress.`,
          };
        }
      } else if (channelLockKey) {
        if (this.activeChannels.has(channelLockKey) || this.isGlobalRunning) {
          return {
            success: false,
            timestamp: new Date().toISOString(),
            durationMs: 0,
            channelsProcessed: 0,
            totalVideosPublished: 0,
            results: [],
            error: `Output pipeline for channel "${channelLockKey}" is already in progress.`,
          };
        }
      } else if (this.isGlobalRunning || this.activeFolders.size > 0 || this.activeChannels.size > 0) {
        return {
          success: false,
          timestamp: new Date().toISOString(),
          durationMs: 0,
          channelsProcessed: 0,
          totalVideosPublished: 0,
          results: [],
          error: 'Output pipeline execution already in progress.',
        };
      }
    }

    if (folderLockKey) {
      this.activeFolders.add(folderLockKey);
    } else if (channelLockKey) {
      this.activeChannels.add(channelLockKey);
    } else {
      this.isGlobalRunning = true;
    }
    try {
      if (!isDbConnected()) {
        try {
          await initDatabase(config.MONGODB_URI, config.MONGODB_DB_NAME);
        } catch (dbErr: any) {
          console.warn('[OutputPipeline] Note: MongoDB connection warning:', dbErr.message);
        }
      }

      let channels: GDriveReelConfig[] = [];
      let dbAvailable = false;
      let db: Db | null = null;

      try {
        db = getDatabase();
        dbAvailable = true;
        channels = await db.collection<GDriveReelConfig>('gdrive_reel_configs').find({}).toArray();
      } catch (findErr: any) {
        console.warn('[OutputPipeline] Note: Could not load channels from DB:', findErr.message);
      }

      // If no channels exist in DB, provide default channel from env variables
      if (channels.length === 0) {
        const defaultFolder = config.GDRIVE_FOLDER_ID;
        const defaultPageId = config.FACEBOOK_PAGE_ID || 'default_page';

        channels = [
          {
            _id: 'default_channel',
            name: 'Primary Broadcast Channel',
            folderUrlOrId: defaultFolder || '',
            folderId: this.scanner.extractFolderId(defaultFolder || ''),
            pageId: defaultPageId,
            pageName: 'Primary Page',
            autoPostYouTube: config.YOUTUBE_AUTO_UPLOAD,
            autoPostTikTok: config.TIKTOK_AUTO_UPLOAD,
            autoPostTelegram: config.TELEGRAM_AUTO_UPLOAD,
            telegramChannelId: config.TELEGRAM_CHANNEL_ID,
            isActive: true,
            scheduleIntervalHours: 2,
            category: 'auto',
            captionStrategy: 'viral_hashtags',
            orderStrategy: config.ORDER_STRATEGY,
            postedVideoIds: [],
            postedVideoNames: [],
            deleteAfterPosting: config.DELETE_AFTER_POSTING,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      }

      let activeChannels = channels.filter((c) => c.isActive !== false);
      if (options?.channelId) {
        activeChannels = channels.filter((c) => c._id === options.channelId);
      } else if (options?.folderId) {
        const targetFid = this.scanner.extractFolderId(options.folderId);
        activeChannels = channels.filter(
          (c) => this.scanner.extractFolderId(c.folderUrlOrId || c.folderId) === targetFid
        );
        // If folder is not yet explicitly in database configs, create an ephemeral pipeline so any folder URL works immediately
        if (activeChannels.length === 0 && targetFid) {
          const fallbackApiKey = channels.find((c) => c.apiKey)?.apiKey || config.GOOGLE_DRIVE_API_KEY;
          const fallbackPageId = config.FACEBOOK_PAGE_ID || channels.find((c) => c.pageId)?.pageId || '';
          activeChannels = [
            {
              _id: `adhoc_${targetFid}`,
              name: `Google Drive Folder (${targetFid})`,
              folderUrlOrId: targetFid,
              folderId: targetFid,
              apiKey: fallbackApiKey,
              pageId: fallbackPageId,
              autoPostYouTube: config.YOUTUBE_AUTO_UPLOAD,
              autoPostTikTok: config.TIKTOK_AUTO_UPLOAD,
              autoPostTelegram: config.TELEGRAM_AUTO_UPLOAD,
              telegramChannelId: config.TELEGRAM_CHANNEL_ID,
              isActive: true,
              scheduleIntervalHours: 1,
              captionStrategy: 'viral_hashtags',
              orderStrategy: config.ORDER_STRATEGY,
              postedVideoIds: [],
              postedVideoNames: [],
              deleteAfterPosting: config.DELETE_AFTER_POSTING,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ];
        }
      } else if (options?.pageId && options.pageId !== 'all') {
        activeChannels = activeChannels.filter((c) => c.pageId === options.pageId);
      }

      console.log(`[OutputPipeline] 📤 Evaluating ${activeChannels.length} active broadcast channel(s) (target folderId=${options?.folderId || 'all'})...`);

      const channelResults: ChannelPublishResult[] = [];
      let totalVideosPublished = 0;

      for (const channel of activeChannels) {
        // Safe timeout guard for global multi-channel runs: stop before hitting Vercel 60s hard timeout
        if (!options?.folderId && !options?.channelId && Date.now() - startTime > 45000) {
          console.warn(`[OutputPipeline] ⏱️ Approaching serverless execution limit (${Date.now() - startTime}ms). Stopping batch safely to prevent 504 timeout.`);
          break;
        }

        const folderId = this.scanner.extractFolderId(
          channel.folderUrlOrId || channel.folderId || config.GDRIVE_FOLDER_ID || ''
        );
        if (!folderId) {
          console.warn(`[OutputPipeline] Channel "${channel.name}" has no Google Drive folder configured.`);
          continue;
        }

        const channelApiKey = channel.apiKey || config.GOOGLE_DRIVE_API_KEY;

        console.log(`\n[OutputPipeline] 📂 Scanning Drive folder for channel: "${channel.name}" (${folderId})...`);
        const scan = await this.scanner.scanFolder(folderId, channel.postedVideoIds || [], channelApiKey);

        if (scan.error) {
          console.error(`[OutputPipeline] Error scanning folder for "${channel.name}":`, scan.error);
          channelResults.push({
            channelId: channel._id,
            channelName: channel.name || 'Channel',
            publishedTo: {},
            error: scan.error,
          });
          continue;
        }

        if (scan.totalVideos === 0) {
          console.log(`[OutputPipeline] ℹ️ No video files found in "${channel.name}" (${folderId}).`);
          channelResults.push({
            channelId: channel._id,
            channelName: channel.name || 'Channel',
            publishedTo: {},
            error: `No video files (.mp4/.mov) found in Google Drive folder ${folderId}.`,
          });
          continue;
        }

        const pendingVideos = scan.videos.filter((v) => !v.isPosted);
        console.log(
          `[OutputPipeline] Found ${scan.totalVideos} total videos (${scan.postedCount} posted, ${pendingVideos.length} pending).`
        );

        if (pendingVideos.length === 0) {
          console.log(`[OutputPipeline] ℹ️ All videos in "${channel.name}" have already been published.`);
          channelResults.push({
            channelId: channel._id,
            channelName: channel.name || 'Channel',
            publishedTo: {},
            error: `All ${scan.totalVideos} videos in "${channel.name}" have already been published.`,
          });
          continue;
        }

        const targetVideo = pendingVideos[0];
        console.log(
          `[OutputPipeline] 🎯 Selected oldest video: "${targetVideo.name}" (${targetVideo.sizeMb} MB)...`
        );

        // 1. Download video buffer
        let videoBuffer: Buffer;
        try {
          videoBuffer = await this.scanner.downloadVideoBuffer(targetVideo, folderId, channelApiKey);
        } catch (downErr: any) {
          console.error(`[OutputPipeline] Failed to download video buffer: ${downErr.message}`);
          channelResults.push({
            channelId: channel._id,
            channelName: channel.name || 'Channel',
            videoTitle: targetVideo.cleanTitle,
            filename: targetVideo.name,
            publishedTo: {},
            error: `Download failed: ${downErr.message}`,
          });
          continue;
        }

        // 2. Prepare captions, hashtags & article link
        const fileTags = this.scanner.extractHashtags(targetVideo.name);
        const customUserTags = [channel.customHashtags, ...fileTags].filter(Boolean).join(' ');

        // Detect language based on the actual video title (do not use channel name, as Bengali videos may be under English channel names)
        const isEnglish = isEnglishText(targetVideo.cleanTitle);

        // Determine if this channel or video is news-related (Exclude non-news channels like 'হক কথা', 'Alisa Kids World', 'Alisa Tech Studio')
        const channelNameLower = (channel.name || '').toLowerCase();
        const pageNameLower = (channel.pageName || '').toLowerCase();
        const isExcludedNonNews =
          channel.pageId === '1302276172975819' || // হক কথা
          channelNameLower.includes('হক কথা') ||
          pageNameLower.includes('হক কথা') ||
          channel.pageId === '1419972727872040' || // Alisa Kids World
          channelNameLower.includes('kids') ||
          pageNameLower.includes('kids') ||
          channel.pageId === '1268359636369219' || // Alisa Tech Studio
          channelNameLower.includes('tech');

        const isNewsChannel =
          !isExcludedNonNews &&
          (channelNameLower.includes('news') ||
            pageNameLower.includes('news') ||
            channel.category === 'news' ||
            channel.pageId === '1405135646008133' || // BD News 24/7
            channel.pageId === '1526917347161119');   // Trending News World

        const hashtags = generateGDriveReelHashtags({
          videoTitle: targetVideo.cleanTitle,
          channelName: channel.name,
          category: channel.category,
          userTags: customUserTags,
          isEnglish,
          isNews: isNewsChannel,
        });

        const caption =
          channel.captionStrategy === 'custom' && channel.customCaption?.trim()
            ? channel.customCaption.replace(/{hashtags}/gi, hashtags).trim()
            : hashtags.trim();

        let newsUrl = '';
        if (dbAvailable && db) {
          try {
            const article = await db.collection<NewsArticle>('news_articles').findOne({
              $or: [
                { gdriveFileId: targetVideo.id },
                { title: targetVideo.cleanTitle },
                { title: targetVideo.name.replace(/\.[^/.]+$/, '').trim() },
              ],
            });
            if (article?.link) {
              newsUrl = article.link.trim();
              console.log(`[OutputPipeline] 🔗 Found matching news link: ${newsUrl}`);
            }
          } catch {}
        }

        // Only assign fallback news domains for authentic news channels
        if (!newsUrl && isNewsChannel) {
          if (channel.pageId === '1526917347161119' || channelNameLower.includes('trending')) {
            newsUrl = 'https://trendingnews.world';
          } else {
            newsUrl = isEnglish ? 'https://trendingnews.world' : 'https://bdnews.site';
          }
        }

        const publishStatus: ChannelPublishResult['publishedTo'] = {};

        // 3A. Publish to Facebook Page (Reels)
        let fbPageAccessToken = config.FACEBOOK_PAGE_ACCESS_TOKEN;
        let fbPageId = channel.pageId || config.FACEBOOK_PAGE_ID;

        if (dbAvailable && db && channel.pageId && channel.pageId !== 'all') {
          try {
            const pageDoc = await db.collection<FacebookPage>('facebook_pages').findOne({ _id: channel.pageId });
            if (pageDoc?.accessToken) {
              fbPageAccessToken = pageDoc.accessToken;
              fbPageId = pageDoc._id;
            }
          } catch {}
        }

        let fbVideoId = '';
        let fbPostId = '';

        if (fbPageId && fbPageAccessToken) {
          try {
            console.log(`[OutputPipeline] 📘 [1/4] Publishing Reel to Facebook Page "${fbPageId}"...`);
            const fbRes = await this.fbClient.publishReel(
              fbPageId,
              fbPageAccessToken,
              videoBuffer,
              caption,
              targetVideo.cleanTitle,
              config.DRY_RUN
            );
            fbVideoId = fbRes.videoId;
            fbPostId = fbRes.postId;

            let commentId = '';
            try {
              let formattedComment = '';
              // 1. If channel has custom firstCommentText, format and publish it
              if (channel.firstCommentText?.trim()) {
                formattedComment = this.fbClient.formatComment(
                  newsUrl,
                  channel.firstCommentText.trim(),
                  isEnglish
                );
              } else if (newsUrl) {
                // 2. Only use default news CTA if there is an actual newsUrl to link to
                formattedComment = this.fbClient.formatComment(
                  newsUrl,
                  config.DEFAULT_COMMENT_FORMAT,
                  isEnglish
                );
              }

              const commentTarget = fbVideoId || fbPostId;
              if (formattedComment && commentTarget) {
                const cRes = await this.fbClient.publishComment(
                  commentTarget,
                  fbPageAccessToken,
                  formattedComment,
                  config.DRY_RUN,
                  fbPostId
                );
                commentId = cRes.commentId;
              }
            } catch (commentErr: any) {
              console.warn(`[OutputPipeline] Comment note: ${commentErr.message}`);
            }

            publishStatus.facebook = { success: true, videoId: fbVideoId, postId: fbPostId, commentId };
            console.log(`✓ [OutputPipeline] Facebook Reel published! (Video ID: ${fbVideoId})`);

            if (dbAvailable && db) {
              await db.collection<ReelLog>('reel_logs').insertOne({
                _id: crypto.randomUUID(),
                articleTitle: targetVideo.cleanTitle,
                pageId: fbPageId,
                pageName: channel.pageName || channel.name || 'Facebook Page',
                fbVideoId,
                fbPostId,
                fbCommentId: commentId || undefined,
                status: config.DRY_RUN ? 'dry_run' : 'success',
                createdAt: new Date(),
              } as any);
            }
          } catch (fbErr: any) {
            console.error(`[OutputPipeline] Facebook publish failed: ${fbErr.message}`);
            publishStatus.facebook = { success: false, error: fbErr.message };
          }
        }

        // 3B. Publish to YouTube (Shorts)
        if (channel.autoPostYouTube !== false && config.YOUTUBE_AUTO_UPLOAD) {
          try {
            let ytClient = new YouTubeClient();
            let matchedYt: YouTubeChannel | undefined;
            if (dbAvailable && db) {
              const ytChannels = await db
                .collection<YouTubeChannel>('youtube_channels')
                .find({ isActive: true })
                .toArray();

              // 1. Direct match by configured youtubeChannelId
              if (channel.youtubeChannelId && channel.youtubeChannelId !== 'all') {
                matchedYt = ytChannels.find((ch: YouTubeChannel) => ch._id === channel.youtubeChannelId);
              }
              // 2. Direct match by linked Facebook pageId
              if (!matchedYt && channel.pageId) {
                matchedYt = ytChannels.find((ch: YouTubeChannel) => ch.targetPageId === channel.pageId);
              }
              // 3. Match by name similarity
              if (!matchedYt && channel.name) {
                const cLower = channel.name.toLowerCase();
                matchedYt = ytChannels.find((ch: YouTubeChannel) => {
                  const tLower = ch.title.toLowerCase();
                  return cLower.includes(tLower) || tLower.includes(cLower);
                });
              }
              // 4. Wildcard match only if explicitly configured as "all"
              if (!matchedYt && channel.youtubeChannelId === 'all') {
                matchedYt = ytChannels.find((ch: YouTubeChannel) => ch.autoUpload);
              }

              if (matchedYt) {
                ytClient = YouTubeClient.forChannel(matchedYt);
              }
            }

            if (matchedYt) {
              console.log(`[OutputPipeline] 📺 [2/4] Publishing Short to YouTube channel "${matchedYt.title}" (${matchedYt._id})...`);
              const ytRes = await ytClient.uploadShort(
                {
                  videoBuffer,
                  title: targetVideo.cleanTitle,
                  description: caption,
                  tags: fileTags,
                  isEnglish,
                },
                config.DRY_RUN
              );

              publishStatus.youtube = {
                success: true,
                videoId: ytRes.videoId,
                videoUrl: ytRes.videoUrl || `https://youtube.com/shorts/${ytRes.videoId}`,
              };
              console.log(`✓ [OutputPipeline] YouTube Short published to "${matchedYt.title}"! (Video ID: ${ytRes.videoId})`);

              if (dbAvailable && db) {
                await db.collection<YouTubeUploadLog>('youtube_upload_logs').insertOne({
                  _id: crypto.randomUUID(),
                  articleTitle: targetVideo.cleanTitle,
                  channelId: matchedYt._id,
                  channelTitle: matchedYt.title,
                  pageId: channel.pageId || undefined,
                  ytVideoId: ytRes.videoId,
                  ytVideoUrl: ytRes.videoUrl || `https://youtube.com/shorts/${ytRes.videoId}`,
                  status: config.DRY_RUN ? 'dry_run' : 'success',
                  createdAt: new Date(),
                });
              }
            } else {
              console.log(`[OutputPipeline] ℹ️ Skipping YouTube upload for "${channel.name}": No matching YouTube channel linked.`);
            }
          } catch (ytErr: any) {
            console.warn(`[OutputPipeline] YouTube upload note: ${ytErr.message}`);
            publishStatus.youtube = { success: false, error: ytErr.message };
          }
        }

        // 3C. Publish to TikTok
        if (channel.autoPostTikTok !== false && (channel.tiktokAccessToken || config.TIKTOK_ACCESS_TOKEN)) {
          try {
            console.log(`[OutputPipeline] 🎵 [3/4] Publishing video to TikTok...`);
            const customTikTok = channel.tiktokAccessToken
              ? new TikTokClient(channel.tiktokAccessToken)
              : this.tikTokClient;

            const tikRes = await customTikTok.uploadVideo(
              {
                videoBuffer,
                title: targetVideo.cleanTitle,
                tags: fileTags,
                isEnglish,
              },
              config.DRY_RUN
            );

            if (tikRes.success) {
              publishStatus.tiktok = { success: true, publishId: tikRes.publishId };
              console.log(`✓ [OutputPipeline] TikTok video published! (Publish ID: ${tikRes.publishId})`);

              if (dbAvailable && db) {
                await db.collection<TikTokUploadLog>('tiktok_upload_logs').insertOne({
                  _id: crypto.randomUUID(),
                  videoTitle: targetVideo.cleanTitle,
                  channelId: channel._id,
                  channelName: channel.name,
                  publishId: tikRes.publishId,
                  status: config.DRY_RUN ? 'dry_run' : 'success',
                  createdAt: new Date(),
                });
              }
            }
          } catch (tikErr: any) {
            console.warn(`[OutputPipeline] TikTok upload note: ${tikErr.message}`);
            publishStatus.tiktok = { success: false, error: tikErr.message };
          }
        }

        // 3D. Publish to Telegram (Direct Video to Channel/Group)
        if (channel.autoPostTelegram !== false && config.TELEGRAM_AUTO_UPLOAD && config.TELEGRAM_BOT_TOKEN) {
          try {
            const targetChat =
              channel.telegramChannelId || config.TELEGRAM_CHANNEL_ID || config.TELEGRAM_CHAT_ID;
            console.log(`[OutputPipeline] ✈️ [4/4] Publishing video directly to Telegram (${targetChat})...`);

            const tgRes = await this.telegramPublisher.publishVideo({
              videoBuffer,
              caption: `${targetVideo.cleanTitle}\n\n${caption}`,
              title: targetVideo.cleanTitle,
              chatId: targetChat,
              isDryRun: config.DRY_RUN,
            });

            if (tgRes.success) {
              publishStatus.telegram = { success: true, messageId: tgRes.messageId };
              console.log(`✓ [OutputPipeline] Telegram video published! (Message ID: ${tgRes.messageId})`);

              if (dbAvailable && db) {
                await db.collection<TelegramUploadLog>('telegram_upload_logs').insertOne({
                  _id: crypto.randomUUID(),
                  videoTitle: targetVideo.cleanTitle,
                  channelId: channel._id,
                  channelName: channel.name,
                  chatId: targetChat || '',
                  messageId: tgRes.messageId,
                  status: config.DRY_RUN ? 'dry_run' : 'success',
                  createdAt: new Date(),
                });
              }
            } else {
              publishStatus.telegram = { success: false, error: tgRes.error };
            }
          } catch (tgErr: any) {
            console.warn(`[OutputPipeline] Telegram publish note: ${tgErr.message}`);
            publishStatus.telegram = { success: false, error: tgErr.message };
          }
        }

        totalVideosPublished++;

        // 4. Update posted list in MongoDB
        if (dbAvailable && db) {
          try {
            await db.collection<GDriveReelConfig>('gdrive_reel_configs').updateOne(
              { _id: channel._id },
              {
                $addToSet: {
                  postedVideoIds: targetVideo.id,
                  postedVideoNames: targetVideo.name,
                },
                $set: {
                  lastPostedAt: new Date(),
                  lastPostedFile: targetVideo.name,
                  updatedAt: new Date(),
                },
              }
            );

            await db.collection('news_articles').updateMany(
              {
                $or: [
                  { gdriveFileId: targetVideo.id },
                  { title: targetVideo.cleanTitle },
                  { title: targetVideo.name.replace(/\.[^/.]+$/, '').trim() },
                ],
              },
              {
                $set: {
                  status: 'published',
                  fbVideoId: fbVideoId || undefined,
                  fbPostId: fbPostId || undefined,
                  updatedAt: new Date(),
                },
              }
            );
          } catch {}
        }

        // 5. Clean up / trash video from Google Drive folder
        let deletedFromDrive = false;
        if (channel.deleteAfterPosting !== false && config.DELETE_AFTER_POSTING) {
          console.log(`[OutputPipeline] 🗑️ Deleting published video "${targetVideo.name}" from Google Drive...`);
          const cleanRes = await this.cleaner.deleteVideo(
            targetVideo.id,
            targetVideo.name,
            folderId,
            channel.deleteAction || 'trash'
          );
          deletedFromDrive = cleanRes.success;
          if (cleanRes.success) {
            console.log(`✓ [OutputPipeline] Successfully removed from Drive (${cleanRes.action})`);
          } else {
            console.warn(`⚠️ [OutputPipeline] Drive deletion note: ${cleanRes.error}`);
          }
        }

        channelResults.push({
          channelId: channel._id,
          channelName: channel.name || 'Channel',
          videoTitle: targetVideo.cleanTitle,
          filename: targetVideo.name,
          publishedTo: publishStatus,
          deletedFromDrive,
        });
      }

      const totalDuration = Date.now() - startTime;
      console.log(
        `\n✓ [OutputPipeline] Broadcast Cycle Complete in ${totalDuration}ms: Published ${totalVideosPublished} video(s)!`
      );

      return {
        success: true,
        timestamp: new Date().toISOString(),
        durationMs: totalDuration,
        channelsProcessed: activeChannels.length,
        totalVideosPublished,
        results: channelResults,
      };
    } catch (err: any) {
      console.error('[OutputPipeline] Fatal broadcast cycle error:', err);
      return {
        success: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        channelsProcessed: 0,
        totalVideosPublished: 0,
        results: [],
        error: err.message,
      };
    } finally {
      if (folderLockKey) {
        this.activeFolders.delete(folderLockKey);
      } else if (channelLockKey) {
        this.activeChannels.delete(channelLockKey);
      } else {
        this.isGlobalRunning = false;
      }
    }
  }
}
