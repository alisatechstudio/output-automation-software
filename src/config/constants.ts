export function isEnglishText(text?: string): boolean {
  if (!text) return false;
  const bengaliCount = (text.match(/[\u0980-\u09FF]/g) || []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  return latinCount > bengaliCount;
}

export function stripCategoryFromTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(
      /^(International|Breaking News|Sports|Economy|Entertainment|Politics|Technology|National|জাতীয়|আন্তর্জাতিক|খেলাধুলা|বিনোদন|রাজনীতি|অর্থনীতি|তথ্যপ্রযুক্তি|বিশেষ খবর)\s*[-:|–]\s*/i,
      ''
    )
    .trim();
}

export interface GenerateGDriveHashtagsOptions {
  videoTitle?: string;
  channelName?: string;
  category?: string;
  userTags?: string;
  isEnglish?: boolean;
  targetCount?: number;
}

export function generateGDriveReelHashtags(options?: GenerateGDriveHashtagsOptions): string {
  const targetCount = options?.targetCount ?? 15;
  const title = (options?.videoTitle || '').trim();
  const isEnglish = options?.isEnglish || isEnglishText(title);

  const baseTags = isEnglish
    ? [
        '#Shorts',
        '#TrendingNews',
        '#BreakingNews',
        '#ViralNews',
        '#WorldNews',
        '#NewsUpdate',
        '#Headlines',
        '#TopStories',
        '#Trending',
        '#Viral',
        '#FYP',
        '#Explore',
      ]
    : [
        '#Shorts',
        '#রিলস',
        '#ব্রেকিংনিউজ',
        '#বাংলাদেশ',
        '#আজকেরখবর',
        '#ভাইরালভিডিও',
        '#bdnews',
        '#banglanews',
        '#viralreels',
        '#trending',
        '#fbreels',
        '#reelsvideo',
      ];

  const userTags = (options?.userTags || '')
    .split(/\s+/)
    .filter((t) => t.startsWith('#'));

  const combined = Array.from(new Set([...userTags, ...baseTags]));
  return combined.slice(0, targetCount).join(' ');
}

export function generateViralReelHashtags(options?: GenerateGDriveHashtagsOptions): string {
  return generateGDriveReelHashtags(options);
}
