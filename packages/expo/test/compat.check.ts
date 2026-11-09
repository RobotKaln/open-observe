// Type contract: the fork is a drop-in replacement of expo-observe. Every export of the original must exist in both entries of
// the fork (native `src/index.ts`, web `src/web/observe.tsx`) with a compatible type; the fork may only ADD (the gate).
// Run: `npm run typecheck` in packages/expo (also from test/compat.test.mjs when TypeScript is installed). Needs `npm install` first.
import * as Original from 'expo-observe';

import * as Native from '../src/index';
import * as Web from '../src/web/observe';

export const native: typeof Original = Native;
export const web: typeof Original = Web;
