import assert from 'node:assert/strict';
import { aggregateWeekly } from './aggregate.mjs';
import { validateMembers } from './run-all.mjs';

const base = {
  employerId: 1,
  status: 'active',
  startedAt: '2026-04-01',
};
const members = [
  { ...base, id: 'wed-fri', name: '水金', weeklyQuota: 2, postingDays: ['水', '金'] },
  { ...base, id: 'sun', name: '日曜', weeklyQuota: 3, postingDays: ['日'] },
  { ...base, id: 'sun-tue-thu', name: '日火木', weeklyQuota: 3, postingDays: ['火', '木', '日'] },
  { ...base, id: 'free', name: '指定なし', weeklyQuota: 7, postingDays: [] },
  {
    ...base,
    id: 'banned',
    name: '垢BAN',
    employerId: null,
    weeklyQuota: 3,
    postingDays: [],
    status: 'banned',
  },
];
const data = {
  version: 1,
  jobs: {
    1: {
      jobId: 1,
      memberId: 'wed-fri',
      title: '1件目',
      postedAt: '2026-07-20',
      postedDatePrecision: 'day',
      employerMatches: true,
      observations: [],
    },
    2: {
      jobId: 2,
      memberId: 'banned',
      title: 'BAN前',
      postedAt: '2026-07-13',
      postedDatePrecision: 'day',
      employerMatches: true,
      observations: [],
    },
    3: {
      jobId: 3,
      memberId: 'removed-member',
      title: '名簿から削除済み',
      postedAt: '2026-07-24',
      postedDatePrecision: 'day',
      employerMatches: true,
      observations: [],
    },
  },
};

const result = aggregateWeekly(
  { members },
  data,
  { weeks: 2, now: new Date('2026-07-23T15:00:00Z') },
);
assert.deepEqual(result.today, {
  date: '2026-07-24',
  dayOfWeek: '金',
  dayNumber: 6,
  remainingDays: 2,
});
assert.equal(result.members[0].weeks[result.currentWeek].pace.expectedByToday, 2);
assert.equal(result.members[0].weeks[result.currentWeek].pace.status, 'behind');
assert.equal(result.members[1].weeks[result.currentWeek].pace.expectedByToday, 3);
assert.equal(result.members[1].weeks[result.currentWeek].pace.status, 'behind');
assert.equal(result.members[2].weeks[result.currentWeek].pace.expectedByToday, 3);
assert.equal(result.members[3].weeks[result.currentWeek].pace.expectedByToday, 6);
assert.equal(result.members[4].banned, true);
assert.equal(result.members[4].weeks[result.currentWeek].pace.status, 'untracked');
assert.equal(result.members[4].weeks['2026-07-12'].postedCount, 1);
assert.equal(result.members[4].weeks['2026-07-12'].achieved, false);
assert.equal(result.totals[result.currentWeek].membersActive, 4);
assert.equal(
  result.members.reduce(
    (total, member) => total + member.weeks[result.currentWeek].postedCount,
    0,
  ),
  1,
);

const expectedByDay = (memberId, isoDate) => {
  const daily = aggregateWeekly(
    { members },
    { version: 1, jobs: {} },
    { weeks: 1, now: new Date(isoDate) },
  );
  const member = daily.members.find(({ id }) => id === memberId);
  return member.weeks[daily.currentWeek].pace.expectedByToday;
};

// 日曜のみは週初日から週間ノルマ全件が目安になる。
for (const isoDate of [
  '2026-07-25T15:00:00Z',
  '2026-07-26T15:00:00Z',
  '2026-07-31T15:00:00Z',
]) {
  assert.equal(expectedByDay('sun', isoDate), 3);
}

// 日・火・木の予定は、日→火→木の順に経過する。
assert.equal(expectedByDay('sun-tue-thu', '2026-07-25T15:00:00Z'), 1);
assert.equal(expectedByDay('sun-tue-thu', '2026-07-26T15:00:00Z'), 1);
assert.equal(expectedByDay('sun-tue-thu', '2026-07-27T15:00:00Z'), 2);
assert.equal(expectedByDay('sun-tue-thu', '2026-07-28T15:00:00Z'), 2);
assert.equal(expectedByDay('sun-tue-thu', '2026-07-29T15:00:00Z'), 3);

// 曜日指定なし（週7件）は日曜1件から土曜7件まで増える。
for (let day = 0; day < 7; day += 1) {
  const now = new Date(Date.UTC(2026, 6, 25 + day, 15));
  assert.equal(expectedByDay('free', now.toISOString()), day + 1);
}

for (const postingDays of [['月曜'], ['月', '月']]) {
  assert.throws(
    () => validateMembers({ members: [{ ...members[0], postingDays }] }),
    /postingDays/,
  );
  assert.throws(
    () => aggregateWeekly({ members: [{ ...members[0], postingDays }] }, data),
    /postingDays/,
  );
}

console.log('曜日・ペース・垢BANのテスト: 全パス');
