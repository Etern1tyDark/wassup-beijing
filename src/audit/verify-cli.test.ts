import 'fake-indexeddb/auto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppDatabase } from '../storage/db';
import { createAuditLog } from './log';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('./verify-cli.ts', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'audit-cli-'));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function verify(file: string, ...extra: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliPath, file, ...extra], { cwd: process.cwd() });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('npm run verify:audit (AUD-3)', () => {
  let goodFile: string;
  let tamperedFile: string;
  let bareArrayFile: string;

  beforeAll(async () => {
    const db = createAppDatabase(`audit-cli-${Math.random().toString(16).slice(2)}`);
    const audit = createAuditLog(db, () => new Date('2026-10-13T02:00:00.000Z'));

    await audit.append({ actor: 'agent', event: 'proposed', action: 'earmark.create', proposalId: 'p_1' });
    await audit.append({ actor: 'user', event: 'approved', action: 'earmark.create', proposalId: 'p_1' });
    await audit.append({
      actor: 'system',
      event: 'executed',
      action: 'earmark.create',
      proposalId: 'p_1',
      payload: { earmarkId: 'ear_1' },
    });

    const exported = await audit.exportJson();
    goodFile = join(directory, 'audit-export.json');
    writeFileSync(goodFile, JSON.stringify(exported, null, 2));

    const tampered = JSON.parse(readFileSync(goodFile, 'utf8')) as typeof exported;
    tampered.entries[1]!.detail = 'changed after the fact';
    tamperedFile = join(directory, 'audit-tampered.json');
    writeFileSync(tamperedFile, JSON.stringify(tampered, null, 2));

    bareArrayFile = join(directory, 'audit-array.json');
    writeFileSync(bareArrayFile, JSON.stringify(exported.entries, null, 2));
  });

  afterAll(() => {
    // The temp directory is intentionally left to the OS to clean up.
  });

  it('accepts a clean export', async () => {
    const result = await verify(goodFile);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/audit chain OK - 3 entries verified/);
  });

  it('accepts a bare array of entries', async () => {
    const result = await verify(bareArrayFile);
    expect(result.code).toBe(0);
  });

  it('fails on a tampered export and explains why', async () => {
    const result = await verify(tamperedFile);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/audit chain FAILED/);
    expect(result.stderr).toMatch(/hash mismatch/);
  });

  it('fails on a file that is not an export', async () => {
    const bad = join(directory, 'not-an-export.json');
    writeFileSync(bad, JSON.stringify({ hello: 'world' }));
    const result = await verify(bad);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/expected an array of entries/);
  });

  it('fails on an empty log, which proves nothing', async () => {
    const empty = join(directory, 'audit-empty.json');
    writeFileSync(empty, JSON.stringify([]));
    const result = await verify(empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/empty/);
  });

  it('fails when entries were cut from the end of an export', async () => {
    const exported = JSON.parse(readFileSync(goodFile, 'utf8')) as { entries: unknown[] };
    exported.entries.pop();
    const truncated = join(directory, 'audit-truncated.json');
    writeFileSync(truncated, JSON.stringify(exported));
    const result = await verify(truncated);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/says 3 entries but contains 2/);
  });

  it('checks the head hash against one recorded elsewhere', async () => {
    const ok = await verify(goodFile);
    const head = /head hash (\S+)/.exec(ok.stdout)![1]!;
    expect((await verify(goodFile, '--expected-head', head)).code).toBe(0);
    const rewritten = await verify(goodFile, '--expected-head', 'f'.repeat(64));
    expect(rewritten.code).toBe(1);
    expect(rewritten.stderr).toMatch(/does not match the expected/);
  });

  it('fails on a missing file', async () => {
    const result = await verify(join(directory, 'does-not-exist.json'));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/could not read/);
  });
});
