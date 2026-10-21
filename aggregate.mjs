#!/usr/bin/env node

import {
  mkdir, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const VALID_STATUSES = new Set(['active', 'paused', 'left', 'banned']);
const POSTING_DAYS = ['日', '月', '火', '水', '木', '金', '土'];

function usage() {
  return `Usage: node aggregate.mjs [options]

Options:
  --members <path>  メンバー設定（既定: ./members.json）
  --data <path>     蓄積データ（既定: ./data/jobs.json）
  --out <path>      集計結果（既定: ./data/weekly.json）
  --weeks <n>       出力する直近の週数（既定: 12）
  --stdout          ファイルに書かず標準出力
  --help            このヘルプを表示`;
}

function parsePositiveInteger(value, option) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${option} には1以上の整数を指定してください`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    membersPath: './members.json',
    dataPath: './data/jobs.json',
    outPath: './data/weekly.json',
    weeks: 12,
    stdout: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stdout') options.stdout = true;
    else if (arg === '--help') options.help = true;
    else if (['--members', '--data', '--out', '--weeks'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} の値がありません`);
      if (arg === '--members') options.membersPath = value;
      if (arg === '--data') options.dataPath = value;
      if (arg === '--out') options.outPath = value;
      if (arg === '--weeks') options.weeks = parsePositiveInteger(value, arg);
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }
  return options;
}

function dateParts(date) {
  const match = DATE_PATTERN.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const checked = new Date(timestamp);
  if (checked.getUTCFullYear() !== year
    || checked.getUTCMonth() !== month - 1
    || checked.getUTCDate() !== day) return null;
  return { year, month, day, timestamp };
}

function formatUtcDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * 掲載日時をJSTの暦日に変換する。
 */
export function toJstDate(postedAt, precision) {
  if (precision === 'day') {
    if (!dateParts(postedAt)) throw new Error(`JST日付が不正です: ${postedAt}`);
    return postedAt;
  }
  if (precision !== 'second') throw new Error(`掲載日時の精度が不正です: ${precision}`);
  if (typeof postedAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(postedAt)) {
    throw new Error(`タイムゾーン付きの掲載日時ではありません: ${postedAt}`);
  }
  const timestamp = Date.parse(postedAt);
  if (Number.isNaN(timestamp)) throw new Error(`掲載日時が不正です: ${postedAt}`);
  return formatUtcDate(timestamp + JST_OFFSET_MS);
}

/**
 * JSTの暦日を、その週の日曜日へ変換する。
 */
export function weekStartOf(jstDate) {
  const parts = dateParts(jstDate);
  if (!parts) throw new Error(`JST日付が不正です: ${jstDate}`);
  const dayOfWeek = new Date(parts.timestamp).getUTCDay();
  return formatUtcDate(parts.timestamp - (dayOfWeek * DAY_MS));
}

function currentJstDate(now) {
  return formatUtcDate(now.getTime() + JST_OFFSET_MS);
}

/**
 * 伸びていない掲載の判定。募集終了・期限切れは対象外にする。
 */
export function isStaleJob(job, todayDate, options = {}) {
  const {
    afterDays = 2,
    maxApplicants = 10,
    withinDays = 14,
  } = options;
  const today = typeof todayDate === 'string'
    ? dateParts(todayDate)
    : todayDate instanceof Date && !Number.isNaN(todayDate.getTime())
      ? dateParts(currentJstDate(todayDate))
      : null;
  const posted = dateParts(job?.postedDate);
  if (!today || !posted || job?.visible === false) return false;
  if (job.recruiting === false) return false;
  const deadline = dateParts(job.applyDeadline);
  if (deadline && deadline.timestamp < today.timestamp) return false;
  if (typeof job.applicantCount !== 'number' || !Number.isFinite(job.applicantCount)) return false;
  const days = Math.floor((today.timestamp - posted.timestamp) / DAY_MS);
  return days >= afterDays
    && days <= withinDays
    && job.applicantCount <= maxApplicants;
}

function todayInfo(now) {
  const date = currentJstDate(now);
  const dayNumber = new Date(dateParts(date).timestamp).getUTCDay() + 1;
  return {
    date,
    dayOfWeek: POSTING_DAYS[dayNumber - 1],
    dayNumber,
    remainingDays: 8 - dayNumber,
  };
}

function expectedByToday(member, dayNumber) {
  if (member.postingDays.length === 0) {
    return Math.ceil(member.weeklyQuota * dayNumber / 7);
  }
  const elapsedDays = member.postingDays.filter(
    (day) => POSTING_DAYS.indexOf(day) + 1 <= dayNumber,
  ).length;
  return Math.ceil(member.weeklyQuota * elapsedDays / member.postingDays.length);
}

function makeWeeks(currentWeek, count) {
  const start = dateParts(currentWeek).timestamp;
  return Array.from({ length: count }, (_, index) => (
    formatUtcDate(start - (index * 7 * DAY_MS))
  ));
}

function latestObservation(job) {
  if (!Array.isArray(job.observations) || job.observations.length === 0) return null;
  return job.observations.reduce((latest, observation) => {
    if (!latest) return observation;
    const currentTime = Date.parse(observation?.observedAt);
    const latestTime = Date.parse(latest?.observedAt);
    if (Number.isNaN(currentTime)) return latest;
    if (Number.isNaN(latestTime) || currentTime >= latestTime) return observation;
    return latest;
  }, null);
}

function emptyWeek() {
  return {
    postedCount: 0,
    achieved: false,
    visibleCount: 0,
    applicantTotal: 0,
    jobs: [],
  };
}

function validateInput(config, data) {
  if (!config || !Array.isArray(config.members)) {
    throw new Error('members.json の members は配列にしてください');
  }
  const ids = new Set();
  for (const member of config.members) {
    if (!member || typeof member.id !== 'string' || !member.id) {
      throw new Error('各メンバーに空でない id が必要です');
    }
    if (ids.has(member.id)) throw new Error(`メンバーIDが重複しています: ${member.id}`);
    ids.add(member.id);
    if (member.employerId !== null
      && (!Number.isSafeInteger(member.employerId) || member.employerId < 1)) {
      throw new Error(`${member.id} の employerId が不正です`);
    }
    if (!Number.isSafeInteger(member.weeklyQuota) || member.weeklyQuota < 1) {
      throw new Error(`${member.id} の weeklyQuota は1以上の整数にしてください`);
    }
    if (!VALID_STATUSES.has(member.status)) {
      throw new Error(`${member.id} の status は active / paused / left / banned のいずれかにしてください`);
    }
    if (!Array.isArray(member.postingDays)) {
      throw new Error(`${member.id} の postingDays は配列にしてください`);
    }
    const postingDays = new Set();
    for (const day of member.postingDays) {
      if (!POSTING_DAYS.includes(day)) {
        throw new Error(`${member.id} の postingDays に不正な曜日があります: ${day}`);
      }
      if (postingDays.has(day)) {
        throw new Error(`${member.id} の postingDays に重複があります: ${day}`);
      }
      postingDays.add(day);
    }
    if (!dateParts(member.startedAt)) throw new Error(`${member.id} の startedAt が不正です`);
  }
  if (!data || data.version !== 1 || !data.jobs || typeof data.jobs !== 'object'
    || Array.isArray(data.jobs)) {
    throw new Error('data/jobs.json の構造またはversionが不正です');
  }
}

/**
 * 読み込んだ設定と案件から週次集計を作る。
 */
export function aggregateWeekly(config, data, { weeks = 12, now = new Date() } = {}) {
  validateInput(config, data);
  if (!Number.isSafeInteger(weeks) || weeks < 1) {
    throw new Error('weeks は1以上の整数にしてください');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now が不正です');

  const today = todayInfo(now);
  const currentWeek = weekStartOf(today.date);
  const weekIds = makeWeeks(currentWeek, weeks);
  const includedWeeks = new Set(weekIds);
  const memberIds = new Set(config.members.map((member) => member.id));
  const jobsByMember = new Map();
  for (const job of Object.values(data.jobs)) {
    // 名簿から削除済みのメンバーの案件は無視する。
    if (!job || typeof job.memberId !== 'string' || !memberIds.has(job.memberId)) continue;
    if (!jobsByMember.has(job.memberId)) jobsByMember.set(job.memberId, []);
    jobsByMember.get(job.memberId).push(job);
  }

  const members = config.members.map((member) => {
    const employerIdMissing = member.employerId === null;
    const banned = member.status === 'banned';
    const memberWeeks = Object.fromEntries(
      weekIds.map((week) => [week, emptyWeek()]),
    );
    let excludedMismatched = 0;
    let excludedBeforeStart = 0;

    // 垢BAN前に取得した実績は、IDが外されても証跡として集計に残す。
    for (const job of employerIdMissing && !banned ? [] : (jobsByMember.get(member.id) ?? [])) {
      if (!job.postedAt || !job.postedDatePrecision) continue;
      const postedDate = toJstDate(job.postedAt, job.postedDatePrecision);
      const mismatched = job.employerMatches === false;
      const beforeStart = postedDate < member.startedAt;
      if (mismatched) excludedMismatched += 1;
      if (beforeStart) excludedBeforeStart += 1;
      if (mismatched || beforeStart) continue;

      const week = weekStartOf(postedDate);
      if (!includedWeeks.has(week)) continue;
      const observation = latestObservation(job);
      const applicantCount = Number.isFinite(observation?.applicantCount)
        ? observation.applicantCount
        : null;
      const visible = observation?.visible === true;
      const recruiting = typeof observation?.recruiting === 'boolean'
        ? observation.recruiting
        : null;
      const applyDeadline = dateParts(observation?.applyDeadline)
        ? observation.applyDeadline
        : null;
      memberWeeks[week].jobs.push({
        jobId: job.jobId,
        title: job.title,
        url: job.url,
        postedAt: job.postedAt,
        postedDate,
        applicantCount,
        visible,
        recruiting,
        applyDeadline,
      });
    }

    for (const week of weekIds) {
      const summary = memberWeeks[week];
      summary.jobs.sort((a, b) => {
        const aTime = a.postedDate === a.postedAt
          ? dateParts(a.postedDate).timestamp - JST_OFFSET_MS
          : Date.parse(a.postedAt);
        const bTime = b.postedDate === b.postedAt
          ? dateParts(b.postedDate).timestamp - JST_OFFSET_MS
          : Date.parse(b.postedAt);
        return bTime - aTime || Number(b.jobId) - Number(a.jobId);
      });
      summary.postedCount = summary.jobs.length;
      summary.achieved = !employerIdMissing && !banned
        && summary.postedCount >= member.weeklyQuota;
      summary.visibleCount = summary.jobs.filter((job) => job.visible).length;
      summary.applicantTotal = summary.jobs.reduce(
        (total, job) => total + (job.applicantCount ?? 0),
        0,
      );
      const isCurrentWeek = week === currentWeek;
      const expected = isCurrentWeek
        ? expectedByToday(member, today.dayNumber)
        : member.weeklyQuota;
      let paceStatus;
      if (banned || employerIdMissing) paceStatus = 'untracked';
      else if (summary.achieved) paceStatus = 'achieved';
      else if (!isCurrentWeek) paceStatus = 'missed';
      else if (summary.postedCount >= expected) paceStatus = 'onTrack';
      else paceStatus = 'behind';
      summary.pace = {
        status: paceStatus,
        expectedByToday: expected,
        remainingDays: isCurrentWeek ? today.remainingDays : 0,
        remainingRequired: Math.max(0, member.weeklyQuota - summary.postedCount),
        isCurrentWeek,
        postingDays: [...member.postingDays],
      };
    }

    return {
      id: member.id,
      name: member.name,
      weeklyQuota: member.weeklyQuota,
      status: member.status,
      banned,
      startedAt: member.startedAt,
      employerIdMissing,
      weeks: memberWeeks,
      excludedMismatched,
      excludedBeforeStart,
    };
  });

  const totals = Object.fromEntries(weekIds.map((week) => {
    const activeMembers = members.filter(
      (member) => member.status === 'active'
        && !member.employerIdMissing
        && weekStartOf(member.startedAt) <= week,
    );
    return [week, {
      membersActive: activeMembers.length,
      membersAchieved: activeMembers.filter((member) => member.weeks[week].achieved).length,
      postedCount: activeMembers.reduce(
        (total, member) => total + member.weeks[week].postedCount,
        0,
      ),
      applicantTotal: activeMembers.reduce(
        (total, member) => total + member.weeks[week].applicantTotal,
        0,
      ),
    }];
  }));

  return {
    version: 1,
    generatedAt: now.toISOString(),
    timezone: 'Asia/Tokyo',
    today,
    currentWeek,
    weeks: weekIds,
    members,
    totals,
  };
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} のJSONが壊れています: ${path}`);
    throw new Error(`${label}を読めません: ${path}: ${error.message}`);
  }
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const membersPath = resolve(options.membersPath);
  const dataPath = resolve(options.dataPath);
  const outPath = resolve(options.outPath);
  const config = await readJson(membersPath, 'メンバー設定');
  const data = await readJson(dataPath, 'データファイル');
  const result = aggregateWeekly(config, data, { weeks: options.weeks });
  if (options.stdout) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else await atomicWrite(outPath, result);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
