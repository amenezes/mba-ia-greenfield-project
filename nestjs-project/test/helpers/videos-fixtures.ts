import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../../src/channels/entities/channel.entity';
import { StorageService } from '../../src/storage/storage.service';
import { User } from '../../src/users/entities/user.entity';
import { Video } from '../../src/videos/entities/video.entity';
import {
  VIDEO_STORAGE_KEYS,
  VideoStatus,
} from '../../src/videos/videos.constants';

export async function createChannel(dataSource: DataSource): Promise<Channel> {
  const suffix = randomUUID().slice(0, 8);
  const user = await dataSource
    .getRepository(User)
    .save({ email: `fixture_${suffix}@example.com`, password: 'hashed' });
  return dataSource
    .getRepository(Channel)
    .save({ name: suffix, nickname: `fixture_${suffix}`, user_id: user.id });
}

/** Seeds a video row (and optionally its stored original/thumbnail objects). */
export async function seedVideo(
  dataSource: DataSource,
  storage: StorageService,
  channelId: string,
  options: {
    status: VideoStatus;
    content?: Buffer;
    thumbnail?: Buffer;
    originalFileName?: string;
  },
): Promise<Video> {
  const id = randomUUID();
  const content = options.content ?? randomBytes(1024);
  const storageKey = VIDEO_STORAGE_KEYS.original(id);
  await storage.putObject(storageKey, content, 'video/mp4');
  let thumbnailKey: string | null = null;
  if (options.thumbnail) {
    thumbnailKey = VIDEO_STORAGE_KEYS.thumbnail(id);
    await storage.putObject(thumbnailKey, options.thumbnail, 'image/jpeg');
  }
  const ready = options.status === VideoStatus.READY;
  return dataSource.getRepository(Video).save({
    id,
    channel_id: channelId,
    slug: randomBytes(8).toString('base64url'),
    title: 'Fixture video',
    status: options.status,
    original_file_name: options.originalFileName ?? 'fixture.mp4',
    content_type: 'video/mp4',
    size_bytes: String(content.length),
    storage_key: storageKey,
    thumbnail_key: thumbnailKey,
    duration_seconds: ready ? 3 : null,
    metadata: ready
      ? {
          formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
          bitRate: 1000,
          width: 320,
          height: 240,
          videoCodec: 'h264',
          audioCodec: 'aac',
        }
      : null,
  });
}
