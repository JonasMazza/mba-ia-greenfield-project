import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import PgBoss from 'pg-boss';
import type { EntityManager } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { VIDEO_QUEUES } from '../videos.constants';

export interface EnsureQueueOptions {
  policy?: PgBoss.QueuePolicy;
}

export interface EnqueueOptions {
  /** Two enqueues sharing a key collapse into one job — the idempotency knob. */
  singletonKey?: string;
  /**
   * When present, the job is inserted through this transaction's connection, so
   * a rollback takes the job with it. Without it there would be a dual write:
   * the row committed and the job enqueued (or vice-versa) independently.
   */
  manager?: EntityManager;
}

/**
 * pg-boss accepts any object exposing `executeSql`, which is how a job can be
 * enqueued on a caller-owned transaction instead of pg-boss's own pool.
 */
function asPgBossDb(manager: EntityManager) {
  return {
    executeSql: async (
      text: string,
      values: unknown[] = [],
    ): Promise<{ rows: any[] }> => {
      const rows = await manager.query<any[]>(text, values);
      return { rows: rows ?? [] };
    },
  };
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly boss: PgBoss;
  private readonly ensuredQueues = new Set<string>();
  private started = false;

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {
    this.boss = new PgBoss({
      connectionString: config.connectionString,
      schema: config.schema,
    });

    // pg-boss is an EventEmitter: an unhandled 'error' would take the process down.
    this.boss.on('error', (error) => {
      this.logger.error('pg-boss error', error);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.start();
    // Every video.process job is keyed by videoId, so `stately` turns that key
    // into real idempotency: a video already queued or being processed cannot
    // be enqueued twice (TD-01).
    await this.ensureQueue(VIDEO_QUEUES.PROCESS, { policy: 'stately' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.boss.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.ensuredQueues.clear();
    await this.boss.stop({ graceful: true, close: true });
  }

  /**
   * pg-boss requires a queue to exist before a job targets it. Creating it is
   * idempotent, and memoizing keeps the extra round-trip off the hot path.
   *
   * The policy is what makes `singletonKey` actually deduplicate: under the
   * default `standard` policy the key is only a label. `stately` allows a single
   * job per key across the created and active states — but it also treats a
   * missing key as one shared key, so only opt in for queues where every job
   * carries a `singletonKey`.
   */
  async ensureQueue(
    name: string,
    options: EnsureQueueOptions = {},
  ): Promise<void> {
    if (this.ensuredQueues.has(name)) {
      return;
    }
    await this.boss.createQueue(name, {
      policy: options.policy ?? 'standard',
      retryLimit: this.config.retryLimit,
      retryDelay: this.config.retryDelaySeconds,
      expireInSeconds: this.config.expireInSeconds,
    });
    this.ensuredQueues.add(name);
  }

  async enqueue<T extends object>(
    name: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    const { singletonKey, manager } = options;
    await this.ensureQueue(name);

    return this.boss.send(name, data, {
      ...(singletonKey && { singletonKey }),
      ...(manager && { db: asPgBossDb(manager) }),
    });
  }

  /** Registers a consumer. The handler receives the job payload, not the envelope. */
  async work<T extends object>(
    name: string,
    handler: (payload: T) => Promise<void>,
  ): Promise<string> {
    await this.ensureQueue(name);

    return this.boss.work<T>(name, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }

  async stopWorking(name: string): Promise<void> {
    await this.boss.offWork(name);
  }
}
