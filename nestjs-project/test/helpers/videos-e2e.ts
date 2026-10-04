import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { MailService } from '../../src/mail/mail.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { useInternalEndpointForPresignedUrls } from '../../src/test/storage';

export interface VideosTestApp {
  app: INestApplication<App>;
  dataSource: DataSource;
}

/** Boots AppModule with the same global pipes/filters as main.ts. */
export async function createVideosTestApp(): Promise<VideosTestApp> {
  // Tests run inside the nestjs-api container, where only `minio` resolves.
  useInternalEndpointForPresignedUrls();

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return { app, dataSource: moduleFixture.get(DataSource) };
}

/** Registers, confirms and logs in a user; returns its access token. */
export async function registerAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();

  let confirmationToken = '';
  jest
    .spyOn(app.get(MailService), 'sendConfirmationEmail')
    .mockImplementationOnce((_email, _name, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return (login.body as { access_token: string }).access_token;
}

/** supertest parser that buffers a binary body (video/image) as a Buffer. */
export function binaryParser(
  res: unknown,
  callback: (err: Error | null, body: Buffer) => void,
): void {
  // supertest hands Node's IncomingMessage to custom parsers.
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

/** Error envelope returned by the API (`{ statusCode, error, message }`). */
export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}
