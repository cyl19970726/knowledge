import { z } from 'zod';
import { ProjectIdSchema, TimestampSchema, VersionRefSchema } from './primitives.js';

/** Acquisition provenance and platform identities are independent observations. */
export const ProviderObservationSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  ref: VersionRefSchema,
  projectId: ProjectIdSchema,
  provider: z.string().trim().min(1),
  observedAt: TimestampSchema,
  acquisition: z.strictObject({
    source: z.enum(['client_provided', 'public_search', 'provider_api', 'manual_import']),
    sourceRef: VersionRefSchema,
  }),
  platform: z.string().trim().min(1),
  platformPostId: z.string().trim().min(1).nullable(),
  creatorAccountId: z.string().trim().min(1).nullable(),
  publisherAccountId: z.string().trim().min(1).nullable(),
  advertiserAccountId: z.string().trim().min(1).nullable(),
  platformAdId: z.string().trim().min(1).nullable(),
  publicDiscoverability: z.enum(['observed_public', 'not_observed', 'unknown']),
});
export type ProviderObservation = z.infer<typeof ProviderObservationSchema>;
