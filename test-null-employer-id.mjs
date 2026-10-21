import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregateWeekly } from './aggregate.mjs';
import { validateMembers } from './run-all.mjs';

const member = {
  id: 'member-missing',
  name: 'ID未設定メンバー',
  employerId: null,
  weeklyQuota: 3,
  postingDays: [],
  status: 'active',
  startedAt: '2026-07-01',
};

validateMembers({ members: [member] });
for (const employerId of [undefined, 0, -1, '123']) {
  assert.throws(
    () => validateMembers({ members: [{ ...member, employerId }] }),
    /employerId が不正/,
  );
}

const aggregated = aggregateWeekly(
  { members: [member] },
  {
    version: 1,
    jobs: {
      123: {
        jobId: 123,
        memberId: member.id,
        postedAt: '2026-07-20',
        postedDatePrecision: 'day',
        employerMatches: true,
        observations: [],
      },
    },
  },
  { weeks: 1, now: new Date('2026-07-26T00:00:00Z') },
);
const aggregatedMember = aggregated.members[0];
assert.equal(aggregatedMember.employerIdMissing, true);
assert.equal(aggregatedMember.weeks[aggregated.currentWeek].postedCount, 0);
assert.equal(aggregatedMember.weeks[aggregated.currentWeek].achieved, false);
assert.equal(aggregated.totals[aggregated.currentWeek].membersActive, 0);

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'cw-tracker-test-'));
try {
  const membersPath = join(temporaryDirectory, 'members.json');
  const dataPath = join(temporaryDirectory, 'jobs.json');
  await writeFile(membersPath, JSON.stringify({ members: [member] }));
  await writeFile(dataPath, JSON.stringify({
    version: 1,
    updatedAt: null,
    jobs: {},
    runs: [{ startedAt: '2026-07-01T00:00:00.000Z' }],
  }));

  const normalRun = spawnSync(
    process.execPath,
    [resolve('run-all.mjs'), '--members', membersPath, '--data', dataPath],
    { encoding: 'utf8' },
  );
  assert.equal(normalRun.status, 0, normalRun.stderr);
  assert.match(normalRun.stderr, /\[1\/1\] ID未設定メンバー \.\.\. スキップ（発注者ID未設定）/);
  const savedData = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(savedData.runs[0].skippedNoEmployerId, undefined);
  assert.equal(savedData.runs[1].skippedNoEmployerId, 1);

  const onlyRun = spawnSync(
    process.execPath,
    [
      resolve('run-all.mjs'),
      '--members', membersPath,
      '--data', dataPath,
      '--only', member.id,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(onlyRun.status, 1);
  assert.match(onlyRun.stderr, /発注者IDが未設定です/);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('employerId未設定のテスト: 全パス');
