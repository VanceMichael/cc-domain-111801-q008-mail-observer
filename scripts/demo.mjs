import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { observeRound } from '../src/app.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);

const directory = await mkdtemp(join(tmpdir(), 'mail-observer-'));
const archive = await new Archive(directory).start();
try {
  const result = await observeRound(new SourceClient(source.url), archive, fixture.folders);
  console.log(JSON.stringify(result.handoff, null, 2));
  console.log('已保存原文与收件记录：', archive.records('INBOX').length + archive.records('HANDOVER').length);
  if (!result.handoff.complete) process.exitCode = 1;
} finally { archive.close(); await source.close();  await rm(directory, { recursive: true, force: true }); }
