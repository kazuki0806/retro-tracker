# CrowdWorks 公開案件クローラー

指定した発注者の「募集実績」公開ページを辿り、案件一覧と各案件の詳細をJSONで取得するCLIです。ログインは行いません。アクセスは常に逐次実行し、各ページの前に1.5〜3秒待機します。

## セットアップ

Node.js v24以降を前提とします。

```bash
npm install
npx playwright install chromium
```

## 使い方

```bash
node crawl.mjs --employer 6918402
node crawl.mjs --employer 6918402 --max-pages 3 --out result.json
npm start -- --employer 6918402 --since 2026-05-01
```

オプション:

- `--employer <id>`: 必須。数値の発注者ID
- `--max-pages <n>`: 募集実績一覧を辿る最大ページ数。既定値は2
- `--known <path>`: 既知の案件IDを入れたJSON配列ファイル。該当IDは詳細ページへアクセスせず、`jobs` にも含めない
- `--since <YYYY-MM-DD>`: この日より前の掲載案件を結果から除外。日付判定に必要なため、詳細取得自体は行う
- `--out <path>`: JSONの出力先。省略時は標準出力
- `--headful`: デバッグ用にChromiumを表示

`--known` の例:

```json
[13332094, 13176521]
```

## 出力

トップレベルには発注者ID、取得時刻、取得した一覧ページ数、発見した案件ID数、一覧で見つけた全案件IDの `allJobIds`、詳細取得成功数、`jobs`、`errors` が入ります。

各案件には案件ID、URL、タイトル、カテゴリ、掲載日時、掲載日時の精度と取得元、ページ上の発注者IDと一致フラグ、応募者数、契約者数、有効期限が入ります。値をページから取得できない項目は `null` です。

- 掲載中案件はJSON-LDを優先し、`postedDatePrecision` は `second`、`postedDateSource` は `jsonld` になります。
- 終了案件はJSON-LDがないためDOMから掲載日を取得します。時刻は取得できず、`postedAt` は `YYYY-MM-DD`、精度は `day`、取得元は `dom` になります。
- `--since` は `postedAt` の日付部分で比較します。掲載日を取得できなかった案件は、情報欠落を隠さないため除外しません。
- `employerMatches` が `false` の案件も残ります。集計時はこのフラグを確認してください。
- 個別案件の取得失敗は処理全体を止めず、理由とメッセージを `errors` に記録します。

発注者が存在しない場合や募集実績一覧そのものを取得できない場合は、JSON形式のエラーを標準エラー出力へ書き、終了コード1で終了します。

## 全メンバーの定期巡回

`members.json` のうち `status` が `active` のメンバーを順番に巡回し、結果を追記型の `data/jobs.json` に保存します。

各メンバーには `weeklyQuota` が必須です。メンバーごとに異なる値を設定でき、1以上の整数でない場合は設定エラーとして停止します。`status` は `active`、`paused`、`left` のいずれかです。

```bash
node run-all.mjs
node run-all.mjs --only member-001 --max-pages 3
node run-all.mjs --members ./members.json --data ./data/jobs.json --dry-run
```

オプション:

- `--members <path>`: メンバー設定。既定値は `./members.json`
- `--data <path>`: 蓄積データ。既定値は `./data/jobs.json`
- `--only <id>`: 指定したactiveメンバーだけを巡回
- `--max-pages <n>`: 各メンバーで辿る最大ページ数。既定値は2
- `--dry-run`: ファイルを更新せず、更新後のデータを標準出力へ表示

メンバー間には3〜5秒の待機が入ります。進捗は標準エラー出力へ表示されます。データファイルは全巡回後に一時ファイルをrenameして1回だけ更新します。既存JSONが壊れている場合は上書きしません。

### `data/jobs.json`

トップレベルは `version`、最終更新日時の `updatedAt`、案件IDをキーにした `jobs`、直近90回分の `runs` です。

案件レコードには初回取得時の掲載情報と `firstSeenAt` を保存します。既存案件の掲載情報は上書きせず、応募者数・契約者数・表示状態を `observations` に追記します。観測は初回を必ず残しながら各案件最大30件に制限します。

掲載から14日以内の案件は毎回再取得します。再取得対象が、今回の一覧で確認できた最古の案件より新しいにもかかわらず一覧から消えた場合は、レコードを削除せず `visible: false` の観測を追加します。最古の案件以前は巡回範囲外として扱い、一覧から案件IDを1件も取得できなかった場合も非表示とは記録しません。14日を超えた案件IDは `crawl.mjs` の既知IDとして詳細取得を省略します。

発注者IDが一致しない案件も証跡として保存し、標準エラー出力に警告します。

`runs` には開始・終了日時、巡回成功メンバー数、新規・更新案件数、発注者ID不一致件数の `mismatchedJobs`、メンバーまたは案件ごとのエラーを記録します。過去のrunに `mismatchedJobs` がなくても読み書きできます。

## 週次集計

`data/jobs.json` と `members.json` からメンバー別・週別の集計を作り、既定では `data/weekly.json` に保存します。ネットワークアクセスは行いません。

```bash
node aggregate.mjs
node aggregate.mjs --weeks 6 --stdout
node aggregate.mjs --members ./members.json --data ./data/jobs.json --out ./data/weekly.json
```

オプション:

- `--members <path>`: メンバー設定。既定値は `./members.json`
- `--data <path>`: 蓄積データ。既定値は `./data/jobs.json`
- `--out <path>`: 集計結果の保存先。既定値は `./data/weekly.json`
- `--weeks <n>`: 現在の週から遡って出力する週数。既定値は12
- `--stdout`: ファイルには書かず、集計結果を標準出力へ表示

週は Asia/Tokyo 固定で、日曜00:00:00 JSTから次の日曜00:00:00 JSTの直前までです。週の識別子には、その週の日曜日を `YYYY-MM-DD` 形式で使用します。時刻付きの掲載日時は一度時刻として解釈してJSTの暦日に直し、日付だけの掲載日は既にJSTの日付として扱います。実行環境のローカルタイムゾーンには依存しません。

### `data/weekly.json`

トップレベルには `version`、生成日時の `generatedAt`、`timezone`、現在の週を示す `currentWeek`、新しい順の `weeks`、メンバー別集計の `members`、週別の全体集計 `totals` が入ります。

各メンバーには設定情報、全対象週の `weeks`、発注者ID不一致による除外数 `excludedMismatched`、参画前掲載による除外数 `excludedBeforeStart` が入ります。案件がない週も必ず作成します。各週には掲載数 `postedCount`、週次目標の達成有無 `achieved`、最新観測で掲載中の `visibleCount`、最新観測の応募者数合計 `applicantTotal`、掲載日時の新しい順に並べた `jobs` が入ります。達成判定には、除外後の `postedCount` だけを使用します。

`totals` は週ごとに、その週までに参画したactiveメンバー数 `membersActive`、そのうち達成した人数 `membersAchieved`、対象メンバーの掲載数と応募者数合計を記録します。`paused` と `left` のメンバーも個別履歴には残りますが、全体集計には含めません。

出力ファイルは一時ファイルへの書き込み後にrenameする方式で更新し、入力の `data/jobs.json` は変更しません。

## ダッシュボード

週次集計をスマホ向けの静的ダッシュボードで確認できます。集計後に `data/weekly.json` を公開用ディレクトリへコピーし、ローカルサーバーを起動してください。

```bash
mkdir -p docs/data
cp data/weekly.json docs/data/weekly.json
python3 -m http.server 8000 --directory docs
```

ブラウザで `http://localhost:8000` を開きます。`docs/data/weekly.json` がない場合は「データがまだありません」と表示されます。

GitHub Pages では公開元を `main` ブランチの `/docs` に設定します。ダッシュボードは外部ライブラリ、Webフォント、外部画像を使用しない完全な静的ページです。

## 制約

- 公開ページのHTML構造に依存するため、サイト側の変更で取得できなくなる可能性があります。
- タイトルはSEO用ではない `h1` の1行目から取得するため、サイト側のマークアップ変更で取得できなくなる可能性があります。
- bot対策を回避する処理、User-Agent偽装、プロキシ、ログイン処理は実装していません。
- 画像・フォント・メディアは読み込みません。ページ取得は最大2回再試行し、各試行の前にも待機します。
