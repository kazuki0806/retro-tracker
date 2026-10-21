# Retro の投稿確認

Retro のメンバーが、クラウドワークスで週の掲載ノルマを守れているかを確認する画面です。
Kir の投稿確認（`~/業務/CW/cw-tracker`）と同じ仕組みですが、**完全に別物**として動いています。

元は `~/claude code/_共通/cw-tracker_型` からコピーしました。

## ★ Kir のほうと混ぜない ★

| | Kir（`~/業務/CW/cw-tracker`） | ここ（Retro） |
|---|---|---|
| メンバーの出どころ | `cw_pm/roster.json` から `sync.py` で生成 | **この `members.json` を直接編集する** |
| 名簿の仕組み | あり（シート・ログパスへも同時反映） | 無し。ここだけで完結する |
| リンク | CW業務アプリの中 | 独立したURL（下記） |

Retro の人を Kir の `roster.json` に入れてはいけません。入れるとKirのAGシートにも名前が流れます。
2026-10-21 に一度入れてしまい、同日に取り消しています。

## リンク

公開URL: https://kazuki0806.github.io/retro-tracker/
リポジトリ: https://github.com/kazuki0806/retro-tracker

**公開ページなので、URLを知っていれば誰でも見られます。** メンバーの名前と掲載状況が表に出ます。
見せたくなくなったら、リポジトリを非公開にしてCloudflare Pagesへ移す形に切り替えます。

## メンバーを足す・直す

`members.json` を編集します。1人ぶんの形は次のとおりです。

```jsonc
{
  "id": "m03",              // m + 連番。あとから変えない
  "name": "山田花子",
  "employerId": 7123456,    // CWの発注者ID。未取得なら null（巡回対象外）
  "weeklyQuota": 2,         // 週の掲載ノルマ
  "postingDays": [],        // 投稿する曜日。決めていなければ []
  "status": "active",       // active / paused / left / banned
  "startedAt": "2026-10-21"
}
```

`employerId` は、本人の案件ページ（`crowdworks.jp/public/jobs/` + 数字）を開いて、
発注者リンクの `/public/employers/` のあとの数字を取ります。
仕事一覧（`job_offers`）やお知らせ（`notifications`）のURLからは取れません。

## 動かし方

手元で1回だけ回すとき:

```bash
cd ~/claude\ code/Retro/cw-tracker && npm run update
```

`npm run update` は、巡回 → 集計 → 画面用データのコピーまで一気にやります。
手元の画面で見たいときは 8831 番（`.claude/launch.json` の `retro-tracker`）。

普段はGitHub Actions が日本時間の7時・12時・19時に自動で巡回し、結果を push します。
画面はその push で更新されます。

## 気をつけること

- 週の始まりは**日曜**
- `status` が `banned` と `employerId` が `null` の人は巡回しない
- 「404なら垢BAN」では判定できない。CWは出稿を止めてもページを残すことがある
- `data/jobs.json` は追記型の証跡なので消さない

## 現在のメンバー

- 市川陽太（employerId 7277511、CWのアカウント名は crea-tive）
- 田村将志（employerId 6985030）

2人とも、CWのログイン情報（アカウント名・メールアドレス・パスワード）は未登録です。
