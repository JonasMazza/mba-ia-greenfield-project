import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1786318884021 } from './migrations/1786318884021-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Enum types are owned by migrations, not by the tables that reference them:
// dropping a table with CASCADE leaves its enum type behind. If the previous
// run ended with the schema migrated, re-running would hit
// `type "..." already exists` on the CREATE TYPE. Drop them explicitly.
const MANAGED_ENUMS = ['video_status', 'verification_tokens_type_enum'];

async function enumExists(
  dataSource: DataSource,
  name: string,
): Promise<boolean> {
  const rows = await dataSource.query<{ typname: string }[]>(
    `SELECT typname FROM pg_type WHERE typname = $1`,
    [name],
  );
  return rows.length > 0;
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, Video, RefreshToken, VerificationToken],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1786318884021,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential, not Promise.all: concurrent `DROP ... CASCADE` on tables tied
    // by foreign keys grab locks in different orders and deadlock.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // Must run after the tables are gone — an enum still in use cannot be dropped.
    for (const enumName of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${enumName}"`);
    }
  });

  afterAll(async () => {
    // The revert tests undo migrations, leaving tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the video_status enum with its four values', async () => {
    const result = await dataSource.query<{ enumlabel: string }[]>(
      `SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'video_status'
        ORDER BY e.enumsortorder`,
    );

    expect(result.map((r) => r.enumlabel)).toEqual([
      'draft',
      'processing',
      'ready',
      'failed',
    ]);
  });

  it('should revert the videos migration, dropping the table and the enum', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(result).toHaveLength(0);
    await expect(enumExists(dataSource, 'video_status')).resolves.toBe(false);
  });

  it('should revert the auth-tokens migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
