#!/usr/bin/env node

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_URL = 'https://crowdworks.jp';
const NAVIGATION_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

class CrawlError extends Error {
  constructor(reason, message, retryable = true) {
    super(message);
    this.name = 'CrawlError';
    this.reason = reason;
    this.retryable = retryable;
  }
}

function usage() {
  return `Usage: node crawl.mjs --employer <id> [options]

Options:
  --employer <id>       必須。クラウドワークスの発注者ID
  --max-pages <n>       募集実績一覧を辿る最大ページ数（既定: 2）
  --known <path>        既知の案件IDを格納したJSON配列
  --since <YYYY-MM-DD>  指定日より前の案件を結果から除外
  --out <path>          JSONの出力先（省略時: 標準出力）
  --headful             ブラウザを表示
  --help                このヘルプを表示`;
}

function parsePositiveInteger(value, option) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new CrawlError('invalid_arguments', `${option} には1以上の整数を指定してください`);
  }
  return Number(value);
}

function isValidCalendarDate(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseArgs(argv) {
  const options = { maxPages: 2, headful: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--headful') {
      options.headful = true;
    } else if (arg === '--help') {
      options.help = true;
    } else if (['--employer', '--max-pages', '--known', '--since', '--out'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new CrawlError('invalid_arguments', `${arg} の値がありません`);
      }
      if (arg === '--employer') options.employerId = parsePositiveInteger(value, arg);
      if (arg === '--max-pages') options.maxPages = parsePositiveInteger(value, arg);
      if (arg === '--known') options.knownPath = value;
      if (arg === '--out') options.outPath = value;
      if (arg === '--since') {
        if (!isValidCalendarDate(value)) {
          throw new CrawlError('invalid_arguments', '--since は YYYY-MM-DD 形式で指定してください');
        }
        options.since = value;
      }
    } else {
      throw new CrawlError('invalid_arguments', `不明なオプションです: ${arg}`);
    }
  }

  if (!options.help && !options.employerId) {
    throw new CrawlError('invalid_arguments', '--employer は必須です');
  }
  return options;
}

async function loadKnownIds(path) {
  if (!path) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new CrawlError('known_file_error', `既知IDファイルを読めません: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
    throw new CrawlError('known_file_error', '--known は正の整数のJSON配列にしてください');
  }
  return new Set(parsed.map(Number));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function politeWait() {
  // 固定間隔よりアクセスが集中しにくいよう、ページ取得間隔に揺らぎを持たせる。
  await sleep(1_500 + Math.floor(Math.random() * 1_501));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRenderedContent(page, pageType) {
  try {
    if (pageType === 'job') {
      await page.waitForFunction(() => (
        document.querySelector('script[type="application/ld+json"]') !== null
        || document.body?.innerText.includes('掲載日')
      ), { timeout: RENDER_TIMEOUT_MS });
    } else if (pageType === 'list') {
      await page.locator('a[href*="/public/jobs/"]').first()
        .waitFor({ state: 'attached', timeout: RENDER_TIMEOUT_MS });
    }
  } catch {
    // 描画待ちの時間切れは、その時点のDOMで取得を続ける。
  }
}

async function navigateWithRetry(page, url, pageType) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await politeWait();
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;

      if (status === 404) throw new CrawlError('not_found', `404 Not Found: ${url}`, false);
      await waitForRenderedContent(page, pageType);
      const bodyText = await page.locator('body').innerText({ timeout: NAVIGATION_TIMEOUT_MS });

      if (bodyText.includes('ページを正しく表示できませんでした')) {
        throw new CrawlError('page_display_error', `ページを正しく表示できませんでした: ${url}`);
      }
      if (!response || status >= 500 || status === 429) {
        throw new CrawlError('detail_fetch_failed', `HTTP ${status || '応答なし'}: ${url}`);
      }
      if (status >= 400) {
        throw new CrawlError('detail_fetch_failed', `HTTP ${status}: ${url}`, false);
      }
      return { bodyText, status };
    } catch (error) {
      lastError = error;
      if (error.retryable === false) throw error;
      if (attempt < MAX_RETRIES) {
        // 通常の取得間隔とは別に、失敗が続くほど待ち時間を伸ばす。
        await sleep(1_000 * (2 ** attempt));
      }
    }
  }
  throw lastError;
}

async function collectJobIds(page, employerId, maxPages) {
  const ids = [];
  const seen = new Set();
  let listPagesFetched = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = `${BASE_URL}/public/employers/${employerId}/job_offers${pageNumber > 1 ? `?page=${pageNumber}` : ''}`;
    try {
      await navigateWithRetry(page, url, 'list');
    } catch (error) {
      if (pageNumber === 1 && ['not_found', 'page_display_error'].includes(error.reason)) {
        throw new CrawlError('employer_not_found', `発注者ID ${employerId} が見つかりません`);
      }
      throw new CrawlError('list_fetch_failed', `募集実績一覧の取得に失敗しました: ${errorMessage(error)}`);
    }
    listPagesFetched += 1;

    const pageData = await page.evaluate(({ employerId: id, nextPage }) => {
      const jobIds = [...document.querySelectorAll('a[href*="/public/jobs/"]')]
        .map((anchor) => anchor.getAttribute('href')?.match(/\/public\/jobs\/(\d+)/)?.[1])
        .filter(Boolean);
      const hasEmployerLink = [...document.querySelectorAll('a[href*="/public/employers/"]')]
        .some((anchor) => anchor.getAttribute('href')?.match(/\/public\/employers\/(\d+)/)?.[1] === String(id));
      const hasNextPage = [...document.querySelectorAll('a[href*="page="]')]
        .some((anchor) => {
          try {
            const link = new URL(anchor.href);
            return link.pathname === `/public/employers/${id}/job_offers`
              && link.searchParams.get('page') === String(nextPage);
          } catch {
            return false;
          }
        });
      return { jobIds, hasEmployerLink, hasNextPage };
    }, { employerId, nextPage: pageNumber + 1 });

    if (pageNumber === 1 && pageData.jobIds.length === 0 && !pageData.hasEmployerLink) {
      throw new CrawlError('employer_not_found', `発注者ID ${employerId} が見つかりません`);
    }
    if (pageData.jobIds.length === 0) break;

    for (const id of pageData.jobIds.map(Number)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (!pageData.hasNextPage) break;
  }
  return { ids, listPagesFetched };
}

function parseJsonLdDate(value) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  if (!isValidCalendarDate(`${year}-${month}-${day}`)
    || Number(hour) > 23
    || Number(minute) > 59
    || Number(second) > 59
    || Number(offsetHour) > 23
    || Number(offsetMinute) > 59) {
    return null;
  }
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function parseDateOnly(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return isValidCalendarDate(date) ? date : null;
}

export async function fetchJobById(page, jobId, expectedEmployerId) {
  const url = `${BASE_URL}/public/jobs/${jobId}`;
  const { bodyText } = await navigateWithRetry(page, url, 'job');
  const raw = await page.evaluate(() => {
    let jsonLd = null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const value = JSON.parse(script.textContent);
        const candidates = Array.isArray(value) ? value : [value];
        jsonLd = candidates.find((item) => item?.['@type'] === 'JobPosting') ?? jsonLd;
      } catch {
        // 関係のない壊れたJSON-LDがあってもDOMフォールバックを続ける。
      }
    }
    const employerHref = document.querySelector('a[href*="/public/employers/"]')?.getAttribute('href');
    const jobHeading = [...document.querySelectorAll('h1')]
      .find((heading) => !heading.className.includes('headerSeoWords'));
    const headingTitle = jobHeading?.textContent
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    const titleFromDocument = document.title.match(/^(.+?)のお仕事\(/)?.[1]?.trim();
    return {
      jsonLd,
      title: headingTitle || titleFromDocument || null,
      jobId: document.title.match(/\[ID:(\d+)\]\s*$/)?.[1] ?? null,
      employerId: employerHref?.match(/\/public\/employers\/(\d+)/)?.[1] ?? null,
    };
  });

  if (Number(raw.jobId) !== jobId) {
    throw new CrawlError(
      'job_id_mismatch',
      `要求した案件ID ${jobId} とページ上の案件ID ${raw.jobId ?? '不明'} が一致しません`,
    );
  }

  const domDate = bodyText.match(/掲載日\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const jsonLdPostedAt = parseJsonLdDate(raw.jsonLd?.datePosted);
  let postedAt = null;
  let postedDatePrecision = null;
  let postedDateSource = null;

  if (jsonLdPostedAt) {
    postedAt = jsonLdPostedAt;
    postedDatePrecision = 'second';
    postedDateSource = 'jsonld';
  } else if (domDate) {
    postedAt = `${domDate[1]}-${domDate[2].padStart(2, '0')}-${domDate[3].padStart(2, '0')}`;
    postedDatePrecision = 'day';
    postedDateSource = 'dom';
  }

  const applicant = bodyText.match(/応募した人\s*([\d,]+)\s*人/);
  const contract = bodyText.match(/契約した人\s*([\d,]+)\s*人/);
  const domDeadline = bodyText.match(/応募期限\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const normalizedDomDeadline = domDeadline
    ? `${domDeadline[1]}-${domDeadline[2].padStart(2, '0')}-${domDeadline[3].padStart(2, '0')}`
    : null;
  const applyDeadline = parseDateOnly(raw.jsonLd?.validThrough)
    ?? (isValidCalendarDate(normalizedDomDeadline ?? '') ? normalizedDomDeadline : null);
  const recruiting = typeof bodyText === 'string'
    ? !/この(お)?仕事の募集は終了/.test(bodyText)
    : null;
  const employerIdOnPage = raw.employerId === null ? null : Number(raw.employerId);

  return {
    jobId,
    url,
    title: raw.title,
    category: raw.jsonLd?.title?.trim() || null,
    postedAt,
    postedDatePrecision,
    postedDateSource,
    employerIdOnPage,
    employerMatches: employerIdOnPage === expectedEmployerId,
    applicantCount: applicant ? Number(applicant[1].replaceAll(',', '')) : null,
    contractCount: contract ? Number(contract[1].replaceAll(',', '')) : null,
    recruiting,
    applyDeadline,
    validThrough: raw.jsonLd?.validThrough || null,
  };
}

export async function crawlEmployer({
  employerId,
  maxPages = 2,
  knownIds = [],
  headful = false,
  browser: sharedBrowser,
  since,
}) {
  const normalizedEmployerId = parsePositiveInteger(String(employerId), 'employerId');
  const normalizedMaxPages = parsePositiveInteger(String(maxPages), 'maxPages');
  const normalizedKnownIds = new Set([...knownIds].map(Number));
  const browser = sharedBrowser ?? await chromium.launch({ headless: !headful });
  try {
    // メンバーごとにコンテキストを分け、Browser本体は呼び出し元で共有できる。
    const context = await browser.newContext();
    try {
      await context.route('**/*', async (route) => {
        if (['image', 'font', 'media'].includes(route.request().resourceType())) {
          await route.abort();
        } else {
          await route.continue();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

      const { ids, listPagesFetched } = await collectJobIds(
        page,
        normalizedEmployerId,
        normalizedMaxPages,
      );
      const jobs = [];
      const errors = [];
      let detailsFetched = 0;

      for (const jobId of ids) {
        if (normalizedKnownIds.has(jobId)) continue;
        try {
          const job = await fetchJobById(page, jobId, normalizedEmployerId);
          detailsFetched += 1;
          if (!since || !job.postedAt || job.postedAt.slice(0, 10) >= since) {
            jobs.push(job);
          }
        } catch (error) {
          errors.push({
            jobId,
            reason: error.reason || 'detail_fetch_failed',
            message: errorMessage(error),
          });
        }
      }

      return {
        employerId: normalizedEmployerId,
        crawledAt: new Date().toISOString(),
        listPagesFetched,
        totalJobIdsFound: ids.length,
        allJobIds: ids,
        discoveredJobIds: ids,
        detailsFetched,
        jobs,
        errors,
      };
    } finally {
      await context.close();
    }
  } finally {
    if (!sharedBrowser) await browser.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const knownIds = await loadKnownIds(options.knownPath);
  const result = await crawlEmployer({ ...options, knownIds });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outPath) await writeFile(options.outPath, json, 'utf8');
  else process.stdout.write(json);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      error: error.reason || 'crawl_failed',
      message: errorMessage(error),
    })}\n`);
    process.exitCode = 1;
  });
}
