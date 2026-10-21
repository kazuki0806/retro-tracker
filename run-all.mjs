#!/usr/bin/env node

import { chromium } from 'playwright';
import {
  mkdir, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crawlEmployer } from './crawl.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_STATUSES = new Set(['active', 'paused', 'left', 'banned']);
const POSTING_DAYS = new Set(['月', '火', '水', '木', '金', '土', '日']);

function usage() {
  return `Usage: node run-all.mjs [options]

Options:
  --members <path>   メンバー設定（既定: ./members.json）
  --data <path>      蓄積データ（既定: ./data/jobs.json）
  --only <id>        特定のメンバーだけ実行
  --max-pages <n>    crawl.mjs に渡す最大ページ数（既定: 2）
  --dry-run          データファイルを書き換えず結果を標準出力
  --help             このヘルプを表示`;
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
    maxPages: 2,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help') options.help = true;
    else if (['--members', '--data', '--only', '--max-pages'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} の値がありません`);
      if (arg === '--members') options.membersPath = value;
      if (arg === '--data') options.dataPath = value;
      if (arg === '--only') options.only = value;
      if (arg === '--max-pages') options.maxPages = parsePositiveInteger(value, arg);
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }
  return options;
}

async function readJson(path, label, missingValue) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && missingValue !== undefined) return missingValue;
    if (error instanceof SyntaxError) {
      throw new Error(`${label} のJSONが壊れています。上書きせず停止します: ${path}`);
    }
    throw new Error(`${label}を読めません: ${path}: ${error.message}`);
  }
}

export function validateMembers(config) {
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
      if (!POSTING_DAYS.has(day)) {
        throw new Error(`${member.id} の postingDays に不正な曜日があります: ${day}`);
      }
      if (postingDays.has(day)) {
        throw new Error(`${member.id} の postingDays に重複があります: ${day}`);
      }
      postingDays.add(day);
    }
  }
}

export function shouldRecordInvisible(jobId, allJobIds, returnedIds, failedIds) {
  if (allJobIds.length === 0) return false;
  return jobId > Math.min(...allJobIds)
    && !returnedIds.has(jobId)
    && !failedIds.has(jobId);
}

function validateData(data) {
  if (!data || data.version !== 1 || !data.jobs || typeof data.jobs !== 'object'
    || Array.isArray(data.jobs) || !Array.isArray(data.runs)) {
    throw new Error('data/jobs.json の構造またはversionが不正です。上書きせず停止します');
  }
}

function isOlderThan14Days(job, now) {
  if (!job.postedAt) return false;
  const postedTime = Date.parse(job.postedAt);
  return !Number.isNaN(postedTime) && postedTime < now.getTime() - (14 * DAY_MS);
}

export function appendObservation(job, observation) {
  const observations = Array.isArray(job.observations) ? job.observations : [];
  observations.push(observation);
  job.observations = observations.length <= 30
    ? observations
    : [observations[0], ...observations.slice(-29)];
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

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
  const config = await readJson(membersPath, 'メンバー設定');
  validateMembers(config);

  const emptyData = { version: 1, updatedAt: null, jobs: {}, runs: [] };
  const data = await readJson(dataPath, 'データファイル', emptyData);
  validateData(data);

  let members = config.members.filter((member) => member.status === 'active');
  if (options.only) {
    const selected = config.members.find((member) => member.id === options.only);
    if (!selected) throw new Error(`--only のメンバーが見つかりません: ${options.only}`);
    if (selected.status !== 'active') {
      throw new Error(`--only のメンバーは active ではありません: ${options.only}`);
    }
    if (selected.employerId === null) {
      throw new Error(`--only のメンバーは発注者IDが未設定です: ${options.only}`);
    }
    members = [selected];
  }

  const startedAt = new Date();
  const run = {
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    membersCrawled: 0,
    newJobs: 0,
    updatedJobs: 0,
    mismatchedJobs: 0,
    skippedNoEmployerId: 0,
    errors: [],
  };
  const browser = members.some((member) => member.employerId !== null)
    ? await chromium.launch({ headless: true })
    : null;

  try {
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      if (member.employerId === null) {
        run.skippedNoEmployerId += 1;
        process.stderr.write(
          `[${index + 1}/${members.length}] ${member.name} ... スキップ（発注者ID未設定）\n`,
        );
        continue;
      }
      const memberStarted = Date.now();
      const recentJobs = Object.values(data.jobs).filter(
        (job) => job.memberId === member.id && !isOlderThan14Days(job, startedAt),
      );
      const knownIds = Object.values(data.jobs)
        .filter((job) => job.memberId === member.id && isOlderThan14Days(job, startedAt))
        .map((job) => job.jobId);

      try {
        const result = await crawlEmployer({
          employerId: member.employerId,
          maxPages: options.maxPages,
          knownIds,
          browser,
        });
        const observedAt = new Date().toISOString();
        const returnedIds = new Set(result.jobs.map((job) => job.jobId));
        const failedIds = new Set(result.errors.map((error) => error.jobId));
        let memberNewJobs = 0;
        let memberUpdatedJobs = 0;

        for (const crawledJob of result.jobs) {
          const key = String(crawledJob.jobId);
          if (!data.jobs[key]) {
            data.jobs[key] = {
              jobId: crawledJob.jobId,
              memberId: member.id,
              employerId: member.employerId,
              url: crawledJob.url,
              title: crawledJob.title,
              category: crawledJob.category,
              postedAt: crawledJob.postedAt,
              postedDatePrecision: crawledJob.postedDatePrecision,
              postedDateSource: crawledJob.postedDateSource,
              employerMatches: crawledJob.employerMatches,
              firstSeenAt: observedAt,
              observations: [],
            };
            memberNewJobs += 1;
          } else {
            memberUpdatedJobs += 1;
          }
          appendObservation(data.jobs[key], {
            observedAt,
            applicantCount: crawledJob.applicantCount,
            contractCount: crawledJob.contractCount,
            visible: true,
            recruiting: typeof crawledJob.recruiting === 'boolean'
              ? crawledJob.recruiting
              : null,
            applyDeadline: crawledJob.applyDeadline ?? null,
          });
          if (!crawledJob.employerMatches) {
            run.mismatchedJobs += 1;
            process.stderr.write(
              `  ⚠ 案件 ${crawledJob.jobId} の発注者IDが一致しません`
              + `（期待 ${member.employerId} / ページ上 ${crawledJob.employerIdOnPage ?? '不明'}）\n`,
            );
          }
        }

        for (const job of recentJobs) {
          if (shouldRecordInvisible(
            job.jobId,
            result.allJobIds,
            returnedIds,
            failedIds,
          )) {
            appendObservation(job, {
              observedAt,
              applicantCount: null,
              contractCount: null,
              visible: false,
              recruiting: null,
              applyDeadline: null,
            });
            memberUpdatedJobs += 1;
          }
        }

        for (const detailError of result.errors) {
          run.errors.push({
            memberId: member.id,
            employerId: member.employerId,
            jobId: detailError.jobId,
            reason: detailError.reason,
            message: detailError.message,
          });
        }
        run.membersCrawled += 1;
        run.newJobs += memberNewJobs;
        run.updatedJobs += memberUpdatedJobs;
        const seconds = ((Date.now() - memberStarted) / 1000).toFixed(1);
        process.stderr.write(
          `[${index + 1}/${members.length}] ${member.name} (${member.employerId}) ... `
          + `${result.totalJobIdsFound}件中 新規${memberNewJobs}件 更新${memberUpdatedJobs}件 (${seconds}秒)\n`,
        );
      } catch (error) {
        const reason = error.reason || 'crawl_failed';
        run.errors.push({
          memberId: member.id,
          employerId: member.employerId,
          reason,
          message: errorText(error),
        });
        process.stderr.write(
          `[${index + 1}/${members.length}] ${member.name} (${member.employerId}) ... 取得失敗: ${reason}\n`,
        );
      }

      if (index < members.length - 1) {
        await sleep(3_000 + Math.floor(Math.random() * 2_001));
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  run.finishedAt = new Date().toISOString();
  data.updatedAt = run.finishedAt;
  data.runs.push(run);
  data.runs = data.runs.slice(-90);

  if (options.dryRun) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else await atomicWrite(dataPath, data);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
