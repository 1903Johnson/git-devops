import { Global, Module } from '@nestjs/common';
import { API_CONFIG } from './common/tokens.js';
import { type ApiConfig, loadConfig } from './config.js';

/**
 * Configuration, read from the environment exactly once.
 *
 * Global because everything needs it and threading a config module import through every
 * feature module is noise. A test overrides `API_CONFIG` on the testing module rather than
 * mutating `process.env`, so suites cannot leak settings into each other.
 */
@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: (): ApiConfig => loadConfig() }],
  exports: [API_CONFIG],
})
export class ConfigModule {}
