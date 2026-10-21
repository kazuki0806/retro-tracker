import assert from 'node:assert/strict';
import { collectAlertJobIds } from './refresh-alerts.mjs';
import { appendObservation } from './run-all.mjs';

const stale = {
  jobId: 101,
  postedDate: '2026-08-08',
  applicantCount: 2,
  visible: true,
  recruiting: true,
  applyDeadline: '2026-08-20',
};
const weekly = {
  today: { date: '2026-08-13' },
  members: [{
    weeks: {
      current: { jobs: [stale] },
      previous: {
        jobs: [
          stale,
          { ...stale, jobId: 102, recruiting: false },
          { ...stale, jobId: 103, visible: false },
        ],
      },
    },
  }],
};

assert.deepEqual(collectAlertJobIds(weekly), [101]);

const job = {
  observations: Array.from({ length: 30 }, (_, index) => ({ observedAt: String(index) })),
};
appendObservation(job, { observedAt: 'new' });
assert.equal(job.observations.length, 30);
assert.equal(job.observations[0].observedAt, '0');
assert.equal(job.observations.at(-1).observedAt, 'new');

console.log('アラート再確認のテスト: 全パス');
