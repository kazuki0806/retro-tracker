import assert from 'node:assert/strict';
import { aggregateWeekly, isStaleJob } from './aggregate.mjs';

const baseJob = {
  postedDate: '2026-08-08',
  applicantCount: 3,
  visible: true,
  recruiting: true,
  applyDeadline: '2026-08-20',
};
const today = '2026-08-13';

assert.equal(isStaleJob(baseJob, today), true);
assert.equal(isStaleJob({ ...baseJob, recruiting: false }, today), false);
assert.equal(isStaleJob({ ...baseJob, applyDeadline: '2026-08-12' }, today), false);
assert.equal(isStaleJob({ ...baseJob, recruiting: null }, today), true);
assert.equal(isStaleJob({ ...baseJob, postedDate: '2026-08-12' }, today), false);
assert.equal(isStaleJob({ ...baseJob, applicantCount: 11 }, today), false);
assert.equal(isStaleJob({ ...baseJob, visible: false }, today), false);
assert.equal(isStaleJob({ ...baseJob, applyDeadline: today }, today), true);

const aggregated = aggregateWeekly(
  {
    members: [{
      id: 'member',
      name: 'テスト',
      employerId: 1,
      weeklyQuota: 1,
      postingDays: [],
      status: 'active',
      startedAt: '2026-08-01',
    }],
  },
  {
    version: 1,
    jobs: {
      1: {
        jobId: 1,
        memberId: 'member',
        postedAt: '2026-08-08',
        postedDatePrecision: 'day',
        employerMatches: true,
        observations: [
          { observedAt: '2026-08-10T00:00:00Z', visible: true },
          {
            observedAt: '2026-08-13T00:00:00Z',
            applicantCount: 3,
            visible: true,
            recruiting: false,
            applyDeadline: '2026-08-12',
          },
        ],
      },
    },
  },
  { weeks: 2, now: new Date('2026-08-13T03:00:00Z') },
);
const aggregatedJob = Object.values(aggregated.members[0].weeks)
  .flatMap((week) => week.jobs)
  .find((job) => job.jobId === 1);
assert.equal(aggregatedJob.recruiting, false);
assert.equal(aggregatedJob.applyDeadline, '2026-08-12');

console.log('伸びていない掲載のテスト: 全パス');
