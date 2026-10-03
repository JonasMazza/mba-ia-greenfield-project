import { registerAs } from '@nestjs/config';

/**
 * Express `trust proxy` value: which hops may set `X-Forwarded-For`. Only
 * those hops are believed, so `req.ip` is the client the trusted proxy saw.
 * A number is a hop count; anything else is a list of addresses/subnets
 * (`loopback`, `uniquelocal`, `172.16.0.0/12`, …). Unset trusts nobody.
 */
function parseTrustProxy(value: string | undefined): false | number | string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : trimmed;
}

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  url: process.env.APP_URL ?? 'http://localhost:3000',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
}));
