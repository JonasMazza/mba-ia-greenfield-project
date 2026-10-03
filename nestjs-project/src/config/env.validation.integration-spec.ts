import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const value = result.value as Record<string, unknown>;
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — STORAGE_PUBLIC_ENDPOINT', () => {
  it('should default to the MinIO port published on the host', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
  });

  it('should accept any URI for the public endpoint', () => {
    const { error } = validate({
      STORAGE_PUBLIC_ENDPOINT: 'https://media.streamtube.example',
    });
    expect(error).toBeUndefined();
  });

  it('should reject a public endpoint that is not a URI', () => {
    const { error } = validate({ STORAGE_PUBLIC_ENDPOINT: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_PUBLIC_ENDPOINT');
  });
});
