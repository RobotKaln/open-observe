import type { D1Migration } from 'cloudflare:test';
import type { Env as Bindings } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
