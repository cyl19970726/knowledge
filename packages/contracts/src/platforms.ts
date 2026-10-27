import { z } from 'zod';

/** Content networks are independent of the services used to acquire their data. */
export const ContentPlatformSchema = z.enum(['tiktok', 'douyin', 'xiaohongshu', 'unknown']);
export type ContentPlatform = z.infer<typeof ContentPlatformSchema>;
export const ContentTypeSchema = z.enum(['video', 'image_post', 'unknown']);
export type ContentType = z.infer<typeof ContentTypeSchema>;
export const PlatformPostIdentitySchema = z.strictObject({
  platform: ContentPlatformSchema.exclude(['unknown']),
  nativeId: z.string().trim().min(1).max(200),
});
export type PlatformPostIdentity = z.infer<typeof PlatformPostIdentitySchema>;

/** Only use for a platform identity; a media hash identifies bytes, not a publication. */
export function platformPostKey(platform: ContentPlatform, nativeId: string): string {
  const parsed = PlatformPostIdentitySchema.parse({ platform, nativeId });
  return `${parsed.platform}:${parsed.nativeId}`;
}

/** Infer only from an explicit canonical host, never from a supplier or numeric ID. */
export function platformFromUrl(value: string | null | undefined): ContentPlatform {
  if (!value) return 'unknown';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return 'unknown';
    if (/(^|\.)tiktok\.com$/i.test(url.hostname)) return 'tiktok';
    if (/(^|\.)douyin\.com$/i.test(url.hostname)) return 'douyin';
    if (/(^|\.)(xiaohongshu\.com|xhslink\.com)$/i.test(url.hostname)) return 'xiaohongshu';
  } catch { /* Unknown/invalid URLs do not establish a platform. */ }
  return 'unknown';
}
