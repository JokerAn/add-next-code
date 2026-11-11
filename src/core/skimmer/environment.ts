import * as path from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

/** 只继承进程运行、npm 下载、代理与证书所需变量，不转发 shell 内的其他凭据。 */
export function skimmerEnvironment(cacheDir: string, nodePath: string): Record<string, string> {
  const env = getDefaultEnvironment();
  const extra = new Set([
    'TMP', 'TEMP', 'TMPDIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'npm_config_registry', 'npm_config_cache', 'npm_config_proxy',
    'npm_config_https_proxy', 'npm_config_cafile',
    'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_CAFILE',
  ]);
  for (const key of extra) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) {
      env[key] = value;
    }
  }
  env.SKIMMER_CACHE_DIR = cacheDir;
  if (path.isAbsolute(nodePath)) {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${path.dirname(nodePath)}${path.delimiter}${env[pathKey] ?? ''}`;
  }
  return env;
}
