import pino, { type Logger } from 'pino';
import { env } from '../config/env.js';

export function createLogger(destination?: pino.DestinationStream): Logger {
  return pino({
    level: env.logLevel,
    redact: {
      paths: [
        'req.headers.cookie', 'req.headers.authorization', 'password', '*.password',
        'token', '*.token', 'secret', '*.secret', 'apiKey', '*.apiKey',
      ],
      censor: '[redacted]',
    },
    base: { service: 'rookstone-api' },
  }, destination);
}

export type AppLogger = Logger;
