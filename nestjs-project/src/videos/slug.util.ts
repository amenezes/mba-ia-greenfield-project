import { randomBytes } from 'node:crypto';

/** 64 random bits encoded as base64url — always 11 URL-safe characters. */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
