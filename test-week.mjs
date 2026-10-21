import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toJstDate, weekStartOf } from './aggregate.mjs';
let ng=0;
const t=(label,got,want)=>{const ok=got===want;if(!ok)ng++;console.log(`  ${ok?'OK ':'NG '} ${label}\n       got=${got} want=${want}`)};

console.log('--- toJstDate: JSTの暦日に変換できるか ---');
t('秒精度 +09:00',            toJstDate('2026-07-25T00:08:09+09:00','second'), '2026-07-25');
t('日精度（既にJST）',        toJstDate('2026-05-17','day'),                   '2026-05-17');
t('UTC表記 → JSTでは翌日',    toJstDate('2026-07-24T16:00:00+00:00','second'), '2026-07-25');
t('UTC表記 → JSTでは同日',    toJstDate('2026-07-24T14:59:59Z','second'),      '2026-07-24');
t('+00:00 深夜 → JST昼',      toJstDate('2026-07-25T03:00:00+00:00','second'), '2026-07-25');

console.log('--- weekStartOf: その日を含む週の日曜 ---');
t('金曜 2026-07-24',          weekStartOf('2026-07-24'), '2026-07-19');
t('日曜ちょうど 2026-07-26',  weekStartOf('2026-07-26'), '2026-07-26');
t('月曜 2026-07-27',          weekStartOf('2026-07-27'), '2026-07-26');
t('土曜 2026-08-01',          weekStartOf('2026-08-01'), '2026-07-26');
t('年またぎ 2027-01-01(金)',  weekStartOf('2027-01-01'), '2026-12-27');

console.log('--- 週境界（掲載時刻ぎりぎり） ---');
t('日曜00:00:00 JST',         weekStartOf(toJstDate('2026-07-26T00:00:00+09:00','second')), '2026-07-26');
t('土曜23:59:59 JST',         weekStartOf(toJstDate('2026-08-01T23:59:59+09:00','second')), '2026-07-26');
t('日曜00:00:00 JSTの1秒前',  weekStartOf(toJstDate('2026-07-25T23:59:59+09:00','second')), '2026-07-19');
t('境界をUTCで表記',           weekStartOf(toJstDate('2026-07-25T15:00:00Z','second')), '2026-07-26');
t('境界を-04:00で表記',        weekStartOf(toJstDate('2026-07-25T11:00:00-04:00','second')), '2026-07-26');

// Nodeの実行タイムゾーンが変わっても結果が同じことを、別プロセスで確認する。
if (!process.env.CW_TZ_CHILD) {
  for (const timezone of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, TZ: timezone, CW_TZ_CHILD: '1' },
    });
    assert.equal(child.status, 0, `TZ=${timezone}\n${child.stdout}\n${child.stderr}`);
  }
}

console.log(ng===0 ? '\n全パス' : `\n${ng}件 失敗`);
process.exit(ng?1:0);
