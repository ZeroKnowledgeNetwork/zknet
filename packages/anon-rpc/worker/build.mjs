// Bundles the worker to one standalone IIFE: dist/zknet-anon-rpc-worker.js.
// The bytes of that file are the Anon-RPC SPEC v0.3.2 §4 artifact —
// keccak256 of them is what a specifier contract's workerHash() pins — so the
// build must be byte-stable: no timestamps, no absolute paths, the same output
// from any working directory. esbuild is pinned exactly at the workspace root for the
// same reason: a different esbuild may emit different bytes.

import { build } from 'esbuild';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, 'dist', 'zknet-anon-rpc-worker.js');
const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

/** Bundle to bytes without writing; exported for the byte-stability test. */
export async function bundle() {
  const result = await build({
    absWorkingDir: here,
    entryPoints: ['src/worker.ts'],
    bundle: true,
    write: false,
    outfile,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    conditions: ['@zknet/source'],
    define: { __ZKNET_WORKER_VERSION__: JSON.stringify(version) },
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  });
  return result.outputFiles[0].contents;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bytes = await bundle();
  // Fresh dist every build: a stale artifact next to the pinned one is an ambiguity.
  await rm(join(here, 'dist'), { recursive: true, force: true });
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, bytes);
  console.log(
    `dist/zknet-anon-rpc-worker.js ${bytes.byteLength} bytes keccak256 0x${bytesToHex(keccak_256(bytes))}`,
  );
}
