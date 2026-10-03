import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import appConfig from './app.config';

const loadConfig = async (
  trustProxy?: string,
): Promise<ConfigType<typeof appConfig>> => {
  if (trustProxy !== undefined) {
    process.env.TRUST_PROXY = trustProxy;
  } else {
    delete process.env.TRUST_PROXY;
  }

  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [appConfig] })],
  }).compile();

  const config = module.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await module.close();
  return config;
};

describe('appConfig.trustProxy', () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it('trusts no proxy when TRUST_PROXY is unset', async () => {
    const config = await loadConfig();
    expect(config.trustProxy).toBe(false);
  });

  it('trusts no proxy when TRUST_PROXY is empty', async () => {
    const config = await loadConfig('');
    expect(config.trustProxy).toBe(false);
  });

  it('reads a number as the count of trusted hops', async () => {
    const config = await loadConfig('1');
    expect(config.trustProxy).toBe(1);
  });

  it('passes addresses and subnets through as given', async () => {
    const config = await loadConfig('loopback, 172.16.0.0/12');
    expect(config.trustProxy).toBe('loopback, 172.16.0.0/12');
  });
});
