import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const AUTH_LIMIT = 10;

/**
 * Every browser request reaches the API through the BFF, so the throttler only
 * tells clients apart when it reads the address the BFF forwards — and only
 * when the hop that forwarded it is trusted.
 */
async function bootApp(trustProxy?: string): Promise<{
  app: INestApplication<App>;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
}> {
  if (trustProxy === undefined) {
    delete process.env.TRUST_PROXY;
  } else {
    process.env.TRUST_PROXY = trustProxy;
  }

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

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

function forgotPassword(app: INestApplication<App>, clientIp?: string) {
  const req = request(app.getHttpServer()).post('/auth/forgot-password');
  if (clientIp) {
    req.set('X-Forwarded-For', clientIp);
  }
  return req.send({ email: 'throttle@example.com' });
}

describe('rate limiting', () => {
  const originalTrustProxy = process.env.TRUST_PROXY;

  afterAll(() => {
    if (originalTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = originalTrustProxy;
    }
  });

  describe('behind a trusted proxy', () => {
    let app: INestApplication<App>;
    let throttlerStorage: ThrottlerStorageService;

    beforeAll(async () => {
      let dataSource: DataSource;
      ({ app, dataSource, throttlerStorage } = await bootApp('loopback'));
      await cleanAllTables(dataSource);
    }, 60000);

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      throttlerStorage.storage.clear();
    });

    it('counts auth requests per forwarded client address', async () => {
      for (let i = 0; i < AUTH_LIMIT; i++) {
        await forgotPassword(app, '203.0.113.1').expect(204);
      }

      await forgotPassword(app, '203.0.113.1').expect(429);
      await forgotPassword(app, '203.0.113.2').expect(204);
    });

    it('does not rate-limit video routes', async () => {
      for (let i = 0; i <= AUTH_LIMIT; i++) {
        await request(app.getHttpServer())
          .get('/videos/doesNotExist')
          .set('X-Forwarded-For', '203.0.113.1')
          .expect(404);
      }
    });
  });

  describe('without a trusted proxy', () => {
    let app: INestApplication<App>;
    let throttlerStorage: ThrottlerStorageService;

    beforeAll(async () => {
      ({ app, throttlerStorage } = await bootApp(undefined));
    }, 60000);

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      throttlerStorage.storage.clear();
    });

    it('ignores a forwarded address the caller made up', async () => {
      for (let i = 0; i < AUTH_LIMIT; i++) {
        await forgotPassword(app, `198.51.100.${i}`).expect(204);
      }

      await forgotPassword(app, '198.51.100.99').expect(429);
    });
  });
});
