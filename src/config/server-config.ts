/**
 * @fileoverview Server-specific configuration: the contact sent in the
 * `AIC-User-Agent` header and the outbound request budget for the Art Institute API.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  contact: z
    .string()
    .trim()
    .max(200)
    .default('https://github.com/cyanheads/art-institute-chicago-mcp-server')
    .describe(
      'Contact the museum can reach (an email or URL), sent in the AIC-User-Agent header on every request.',
    ),
  requestsPerMinute: z.coerce
    .number()
    .int()
    .min(1)
    .max(600)
    .default(50)
    .describe(
      'Outbound request budget per minute for api.artic.edu; the published anonymous limit is 60.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parse and cache the server config from the environment. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    contact: 'AIC_CONTACT',
    requestsPerMinute: 'AIC_REQUESTS_PER_MINUTE',
  });
  return _config;
}
