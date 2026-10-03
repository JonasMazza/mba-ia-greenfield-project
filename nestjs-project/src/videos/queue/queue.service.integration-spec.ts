import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { createTestDataSource } from '../../test/create-test-data-source';
import { QueueService } from './queue.service';

interface ProcessPayload {
  videoId: string;
}

/** Polls until `predicate` holds or the budget runs out — pg-boss delivery is asynchronous. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 20000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('QueueService (integration)', () => {
  let service: QueueService;
  let dataSource: DataSource;
  const workedQueues: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] })],
      providers: [QueueService],
    }).compile();

    service = module.get(QueueService);
    await service.start();

    dataSource = createTestDataSource([], { synchronize: false });
    await dataSource.initialize();
  }, 60000);

  afterAll(async () => {
    for (const name of workedQueues) {
      await service.stopWorking(name).catch(() => undefined);
    }
    await service.stop();
    await dataSource.destroy();
  }, 30000);

  /** A fresh queue per test keeps jobs from leaking across cases. */
  function newQueueName(): string {
    return `test.video.process.${randomUUID().slice(0, 8)}`;
  }

  async function consume(name: string, sink: ProcessPayload[]): Promise<void> {
    workedQueues.push(name);
    await service.work<ProcessPayload>(name, async (payload) => {
      sink.push(payload);
      return Promise.resolve();
    });
  }

  it('should deliver an enqueued job to the registered handler with the same payload', async () => {
    const queue = newQueueName();
    const received: ProcessPayload[] = [];
    const videoId = randomUUID();

    await consume(queue, received);
    const jobId = await service.enqueue(queue, { videoId });

    expect(jobId).toBeTruthy();
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ videoId });
  }, 40000);

  it('should collapse two enqueues sharing a singletonKey into a single job', async () => {
    const queue = newQueueName();
    const videoId = randomUUID();

    await service.ensureQueue(queue, { policy: 'stately' });
    const first = await service.enqueue(
      queue,
      { videoId },
      { singletonKey: videoId },
    );
    const second = await service.enqueue(
      queue,
      { videoId },
      { singletonKey: videoId },
    );

    // The duplicate is rejected at insert time — pg-boss returns no job id.
    expect(first).toBeTruthy();
    expect(second).toBeNull();

    const received: ProcessPayload[] = [];
    await consume(queue, received);
    await waitFor(() => received.length === 1);
    // Give a straggler duplicate a chance to show up before asserting there is none.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(received).toHaveLength(1);
  }, 40000);

  it('should enqueue inside a caller transaction and keep the job on commit', async () => {
    const queue = newQueueName();
    const received: ProcessPayload[] = [];
    const videoId = randomUUID();

    await consume(queue, received);
    await dataSource.transaction(async (manager) => {
      await service.enqueue(queue, { videoId }, { manager });
    });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ videoId });
  }, 40000);

  it('should discard the job when the surrounding transaction rolls back', async () => {
    const queue = newQueueName();
    const received: ProcessPayload[] = [];
    const videoId = randomUUID();

    await consume(queue, received);
    await expect(
      dataSource.transaction(async (manager) => {
        await service.enqueue(queue, { videoId }, { manager });
        throw new Error('rollback on purpose');
      }),
    ).rejects.toThrow('rollback on purpose');

    // Long enough for a job that survived the rollback to be picked up.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(received).toHaveLength(0);
  }, 40000);

  /** A second QueueService over the same database, with its own queue settings. */
  async function startServiceWith(
    overrides: Partial<ConfigType<typeof queueConfig>>,
  ): Promise<QueueService> {
    const module = await Test.createTestingModule({
      providers: [
        QueueService,
        {
          provide: queueConfig.KEY,
          useValue: { ...queueConfig(), ...overrides },
        },
      ],
    }).compile();
    const other = module.get(QueueService);
    await other.start();
    return other;
  }

  async function readQueueSettings(
    name: string,
  ): Promise<{ retry_limit: number; expire_seconds: number }> {
    const [row] = await dataSource.query<
      { retry_limit: number; expire_seconds: number }[]
    >('SELECT retry_limit, expire_seconds FROM pgboss.queue WHERE name = $1', [
      name,
    ]);
    return row;
  }

  it('should bring an existing queue in line with the configured retry and expiration settings', async () => {
    const queue = newQueueName();
    const previous = await startServiceWith({
      retryLimit: 7,
      expireInSeconds: 120,
    });
    await previous.ensureQueue(queue);
    await previous.stop();
    await expect(readQueueSettings(queue)).resolves.toEqual({
      retry_limit: 7,
      expire_seconds: 120,
    });

    // The worker decides the last attempt from the env, so the queue must
    // follow the env too instead of keeping what it was created with.
    await service.ensureQueue(queue);

    const config = queueConfig();
    await expect(readQueueSettings(queue)).resolves.toEqual({
      retry_limit: config.retryLimit,
      expire_seconds: config.expireInSeconds,
    });
  }, 40000);

  it('should copy a job that spent its retries into the dead-letter queue', async () => {
    const queue = newQueueName();
    const deadLetter = `${queue}.dead-letter`;
    const noRetries = await startServiceWith({
      retryLimit: 0,
      retryDelaySeconds: 0,
    });
    const deadLettered: ProcessPayload[] = [];
    const videoId = randomUUID();

    try {
      await noRetries.ensureQueue(queue, { deadLetter });
      await noRetries.work<ProcessPayload>(queue, () =>
        Promise.reject(new Error('handler failed on purpose')),
      );
      await noRetries.work<ProcessPayload>(deadLetter, async (payload) => {
        deadLettered.push(payload);
        return Promise.resolve();
      });

      await noRetries.enqueue(queue, { videoId });

      await waitFor(() => deadLettered.length === 1);
      expect(deadLettered[0]).toEqual({ videoId });
    } finally {
      await noRetries.stop();
    }
  }, 40000);
});
