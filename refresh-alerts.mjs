#!/usr/bin/env node

import { chromium } from 'playwright';
import {
  mkdir, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateWeekly, isStaleJob } from './aggregate.mjs';
import { fetchJobById } from './crawl.mjs';
import { appendObservation, validateMembers } from './run-all.mjs';

const NAVIGATION_TIMEOUT_MS = 30_000;

function usage() {
  return `Usage: node refresh-alerts.mjs [options]

Options:
  --data <path>     蓄積データ（既定: ./data/jobs.json）
  --weekly <path>   集計データ（既定: ./data/weekly.json）
  --members <path>  メンバー設定（既定: ./members.json）
  --dry-run         ファイルを書き換えず結果だけ表示
  --help            このヘルプを表示`;
}

function parseArgs(argv) {
  const options = {
    dataPath: './data/jobs.json',
    weeklyPath: './data/weekly.json',
    membersPath: './members.json',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help') options.help = true;
    else if (['--data', '--weekly', '--members'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} の値がありません`);
      if (arg === '--data') options.dataPath = value;
      if (arg === '--weekly') options.weeklyPath = value;
      if (arg === '--members') options.membersPath = value;
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }
  return options;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} のJSONが壊れています: ${path}`);
    throw new Error(`${label}を読めません: ${path}: ${error.message}`);
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export function collectAlertJobIds(weekly) {
  const today = weekly?.today?.date;
  const ids = new Set();
  for (const member of weekly?.members ?? []) {
    for (const week of Object.values(member?.weeks ?? {})) {
      for (const job of week?.jobs ?? []) {
        if (isStaleJob(job, today)) ids.add(Number(job.jobId));
      }
    }
  }
  return [...ids].filter(Number.isSafeInteger);
}

function isInvisibleError(error) {
  return ['not_found', 'page_display_error'].includes(error?.reason)
    || /^HTTP 403\b/.test(error?.message ?? '');
}

function observationFrom(job, observedAt) {
  return {
    observedAt,
    applicantCount: job.applicantCount,
    contractCount: job.contractCount,
    visible: true,
    recruiting: typeof job.recruiting === 'boolean' ? job.recruiting : null,
    applyDeadline: job.applyDeadline ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const dataPath = resolve(options.dataPath);
  const weeklyPath = resolve(options.weeklyPath);
  const membersPath = resolve(options.membersPath);
  const [data, weekly, config] = await Promise.all([
    readJson(dataPath, 'データファイル'),
    readJson(weeklyPath, '集計データ'),
    readJson(membersPath, 'メンバー設定'),
  ]);
  validateMembers(config);
  if (!data || data.version !== 1 || !data.jobs || typeof data.jobs !== 'object') {
    throw new Error('data/jobs.json の構造またはversionが不正です');
  }

  const jobIds = collectAlertJobIds(weekly);
  if (jobIds.length === 0) {
    process.stderr.write('アラート対象は0件です\n');
    return;
  }
  process.stderr.write(`アラート対象 ${jobIds.length}件を再確認します\n`);

  const browser = await chromium.launch({ headless: true });
  const counts = { ended: 0, invisible: 0, unchanged: 0, failed: 0 };
  try {
    const context = await browser.newContext();
    try {
      await context.route('**/*', async (route) => {
        if (['image', 'font', 'media'].includes(route.request().resourceType())) await route.abort();
        else await route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

      for (const jobId of jobIds) {
        const storedJob = data.jobs[String(jobId)];
        if (!storedJob) {
          counts.failed += 1;
          process.stderr.write(`  ${jobId} 失敗（蓄積データにありません）\n`);
          continue;
        }
        const observedAt = new Date().toISOString();
        try {
          const fetched = await fetchJobById(page, jobId, storedJob.employerId);
          appendObservation(storedJob, observationFrom(fetched, observedAt));
          if (fetched.recruiting === false) {
            counts.ended += 1;
            process.stderr.write(`  ${jobId} 募集終了（アラートから外れます）\n`);
          } else {
            counts.unchanged += 1;
            process.stderr.write(`  ${jobId} 募集中・応募${fetched.applicantCount ?? '不明'}人\n`);
          }
        } catch (error) {
          if (isInvisibleError(error)) {
            appendObservation(storedJob, {
              observedAt,
              applicantCount: null,
              contractCount: null,
              visible: false,
              recruiting: null,
              applyDeadline: null,
            });
            counts.invisible += 1;
            process.stderr.write(`  ${jobId} 非公開（アラートから外れます）\n`);
          } else {
            counts.failed += 1;
            process.stderr.write(`  ${jobId} 取得失敗: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  process.stderr.write(
    `更新: 募集終了${counts.ended}件 / 非公開${counts.invisible}件 / 変化なし${counts.unchanged}件`
    + `${counts.failed ? ` / 取得失敗${counts.failed}件` : ''}\n`,
  );

  if (options.dryRun) return;
  data.updatedAt = new Date().toISOString();
  const weeks = Array.isArray(weekly.weeks) && weekly.weeks.length > 0 ? weekly.weeks.length : 12;
  const aggregated = aggregateWeekly(config, data, { weeks });
  await atomicWrite(dataPath, data);
  await atomicWrite(weeklyPath, aggregated);
  await atomicWrite(resolve('./docs/data/weekly.json'), aggregated);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
