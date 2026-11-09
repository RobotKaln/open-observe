// The group an error belongs to: its type plus the first frames of its stack, without the parts that change from
// build to build (paths, line and column numbers, hashes). Without a stack, the message with its digits removed.
import { sha256Hex } from './crypto';
import type { LogRow } from './types';

const FRAMES = 3;

// "at fn (file:1:2)" (V8, Hermes), "fn@file:1:2" (Firefox, Safari) -> "fn". A frame without a function name is "<anon>".
function frameName(line: string): string {
  let name: string;
  if (line.startsWith('at ')) {
    const rest = line.slice(3);
    const paren = rest.indexOf(' (');
    name = paren === -1 ? '' : rest.slice(0, paren);
  } else {
    const at = line.indexOf('@');
    name = at === -1 ? '' : line.slice(0, at);
  }
  name = name.replace(/^async\s+/, '').replace(/\s*\[as [^\]]*\]/g, '').replace(/\d{3,}/g, '#').trim();
  return name || '<anon>';
}

const isFrame = (line: string) => /^at\s/.test(line) || /@\S*:\d+/.test(line) || /:\d+:\d+\)?$/.test(line);

export function fingerprintInput(type: string, stack: string | null, message: string | null): string {
  const lines = (stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const frames = lines.filter(isFrame);
  let parts: string[];
  if (frames.length > 0) parts = frames.slice(0, FRAMES).map(frameName);
  else if (lines.length > 0) parts = lines.slice(0, FRAMES).map((l) => l.replace(/\d+/g, '#').replace(/\[hex\]|\[num\]/g, '#').slice(0, 80));
  else parts = [(message ?? '').replace(/\d+/g, '#').replace(/\[[a-z]+\]/g, '#').slice(0, 100)];
  return `${type}\n${parts.join('\n')}`;
}

// 16 hex characters.
export async function fingerprint(type: string, stack: string | null, message: string | null): Promise<string> {
  return (await sha256Hex(fingerprintInput(type, stack, message))).slice(0, 16);
}

export async function withFingerprints<T extends { row: LogRow }>(items: T[]): Promise<T[]> {
  await Promise.all(
    items.map(async ({ row }) => {
      if (row.errorType !== null) row.fingerprint = await fingerprint(row.errorType, row.stack, row.body);
    }),
  );
  return items;
}
