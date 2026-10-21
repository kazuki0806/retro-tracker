# セットアップ手順

> **最重要：GitHubリポジトリは必ず「Private（非公開）」で作成してください。**
>
> このリポジトリには、メンバーの実名とクラウドワークスの発注者IDが入ります。Public（公開）にすると、これらの情報を誰でも閲覧できるためです。

## 1. GitHubリポジトリを作る

GitHubにログインし、画面右上の「＋」から「New repository」を選びます。

1. Repository name（リポジトリ名）を入力します。例：`cw-tracker`
2. Visibility（公開範囲）は必ず **Private** を選びます。
3. README、`.gitignore`、Licenseを追加する項目は選ばず、「Create repository」を押します。

次に、ターミナル（文字でパソコンを操作するアプリ）を開き、このフォルダへ移動します。以下の `<このフォルダの場所>` と `<GitHubのユーザー名>` は実際の値に置き換えてください。

```bash
cd "<このフォルダの場所>"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<GitHubのユーザー名>/cw-tracker.git
git push -u origin main
```

`git` はファイルの変更履歴を記録する仕組み、`push` はその履歴をGitHubへ送る操作です。GitHubの画面を再読み込みし、ファイルが表示されれば完了です。

認証情報やアクセストークンをファイルへ書く必要はありません。このシステムはクラウドワークスへログインせず、公開ページだけを巡回するため、秘密情報そのものが不要です。パスワードやトークンをリポジトリへ追加しないでください。

## 2. `members.json` を実際のメンバーで埋める

`members.json` をテキストエディタで開き、サンプルを実際のメンバー情報へ置き換えます。

発注者IDは次の手順で調べます。

1. そのメンバーが掲載した案件ページを開きます。
2. ページ内の発注者名のリンクをクリックします。
3. 開いたページのURLを確認します。たとえば `https://crowdworks.jp/public/employers/6918402` なら、末尾の `6918402` がその人の発注者IDです。

各項目は次のように設定します。

```json
{
  "id": "member-001",
  "name": "山田太郎",
  "employerId": 6918402,
  "weeklyQuota": 3,
  "postingDays": ["月", "水", "金"],
  "status": "active",
  "startedAt": "2026-05-01"
}
```

- `id`：メンバーを識別する重複しない文字列。一度決めたら変更しません。
- `name`：画面に表示する名前。
- `employerId`：上記の手順で調べた発注者ID。まだ分からない場合は `null` にします。
- `weeklyQuota`：そのメンバー個人の週間掲載ノルマ。1以上の整数で設定します。
- `postingDays`：投稿予定の曜日を日本語1文字で指定します（例：`["月", "水", "金"]`）。曜日を決めない場合は `[]` にします。重複や `月曜`、`Mon` などの値があると処理は停止します。曜日数と `weeklyQuota` は一致しなくても構いません。
- `status`：稼働中は `active`、休止中は `paused`、離脱済みは `left`、アカウントがBANされた場合は `banned`。
- `startedAt`：参画日を `YYYY-MM-DD` 形式で入力します。この日より前の掲載は集計から除外されます。

週は日本時間の日曜00:00:00から翌日曜00:00:00未満です。週の識別子には、その週の日曜日を `YYYY-MM-DD` 形式で使用します。曜日番号は日=1、月=2、火=3、水=4、木=5、金=6、土=7として、当日までの掲載目安を計算します。

編集後は、変更をGitHubへ送ります。

```bash
git add members.json
git commit -m "メンバー情報を設定"
git push
```

## 3. 初回の実行

[Node.js](https://nodejs.org/) 24系をインストールしたうえで、このフォルダのターミナルから次を順番に実行します。

```bash
npm ci
npx playwright install chromium
node run-all.mjs
node aggregate.mjs
cp data/weekly.json docs/data/weekly.json
```

`npm ci` は必要な部品を正確にインストールする操作です。`run-all.mjs` が案件を巡回し、`aggregate.mjs` が週ごとの結果を作ります。

初回は現在の案件だけでなく、取得可能な過去の掲載履歴も遡って取り込みます。目安として「メンバー人数 × 約1分」かかるため、画面を閉じずに待ってください。終了後、`data/jobs.json`、`data/weekly.json`、`docs/data/weekly.json` が更新されていることを確認します。

確認したデータも履歴としてGitHubへ送ります。

```bash
git add data/jobs.json data/weekly.json docs/data/weekly.json
git commit -m "初回の巡回結果を追加"
git push
```

以後、巡回・集計・配信用データのコピーは次の1コマンドでも実行できます。

```bash
npm run update
```

## 4. Cloudflare Pagesで配信する

1. [Cloudflare](https://dash.cloudflare.com/sign-up) でアカウントを作成し、ログインします。
2. Cloudflareダッシュボードの「Workers & Pages」を開きます。
3. 「Create application」→「Pages」→「Connect to Git」を選びます。
4. GitHubを選び、連携を許可します。対象はこのリポジトリだけに絞ることを推奨します。
5. 作成したプライベートリポジトリを選び、「Begin setup」へ進みます。
6. Production branch（配信に使うブランチ）を `main` にします。
7. Framework presetはフレームワークなしの設定にし、ビルド設定を次のとおり入力します。
   - Build command（ビルドコマンド）：**空欄**
   - Build output directory（出力ディレクトリ）：`docs`
8. 「Save and Deploy」を押します。

完了画面またはプロジェクト画面に `https://プロジェクト名.pages.dev` 形式のProduction URLが表示されます。アクセス制限を設定するまでは、このURLを他人へ共有しないでください。

## 5. アクセス制限をかける（重要）

> **警告：この設定をしないと、URLを知っている人は誰でもメンバーの実名と達成状況を閲覧できます。配信後、必ず続けて設定してください。**

Cloudflare Accessは、Webページの前にログイン確認を置く機能です。小規模なチームであればCloudflare Zero Trustの無料枠で足ります。

1. Cloudflareダッシュボードの「Workers & Pages」から作成したPagesプロジェクトを開きます。
2. 「Settings」→「Enable access policy」を選び、Accessポリシーを有効にします。
3. 初回だけZero Trustの組織名（チーム名）などを求められたら、画面に従って無料プランで作成します。
4. Pages設定から作られたAccessポリシーの「Manage」を押します。
5. 「Zero Trust」→「Access controls」→「Applications」で対象プロジェクトを開き、「Configure」を選びます。
6. Production URL全体を保護するため、「Public hostname」のSubdomainにワイルドカード `*` があれば削除して保存します。プレビューURLも保護する場合は、Pagesプロジェクトの設定へ戻り、再度「Enable access policy」を選びます。
7. 対象アプリの「Policies」でAllow（許可）ポリシーを作成または編集します。
8. Includeルールで「Emails」を選び、閲覧を許可するメールアドレスだけを1件ずつ登録して保存します。メールドメイン全体ではなく、個別アドレスを指定してください。
9. 必要に応じて「Zero Trust」→「Integrations」→「Identity providers」で「One-time PIN」を追加します。これにより、許可された人はメールで届く使い捨てコードを使ってログインできます。

最後に、いったんログアウトしたブラウザまたはシークレットウィンドウでProduction URLを開きます。ログイン画面が表示されること、許可したメールアドレスでは入れること、許可していないメールアドレスでは入れないことを確認してください。

独自ドメインを後から追加する場合は、その独自ドメインについてもAccessアプリケーションとAllowポリシーを別途設定し、保護漏れがないことを確認してください。

## 6. GitHub Actionsの自動実行を確認する

GitHub Actionsは、決めた時刻にGitHub側でコマンドを自動実行する機能です。

1. GitHubのリポジトリを開き、「Actions」タブを選びます。
2. 左側の「毎日の巡回・集計」を選びます。
3. 「Run workflow」→ブランチ `main` →「Run workflow」を押します。
4. 表示された実行履歴を開き、すべての処理に緑色のチェックが付くことを確認します。
5. `data/jobs.json`、`data/weekly.json`、`docs/data/weekly.json` に変更があった場合だけ、自動コミットが追加されます。

設定後は毎日 **日本時間の午前7時** に全メンバーを巡回します。加えて、アラート対象の案件だけを約6時間おき（午前1時30分・7時30分・午後1時30分・7時30分）に見直すため、募集終了や非公開化がアラートへ早く反映されます。GitHub Actionsのスケジュールは混雑により開始が少し遅れる場合があります。

ワークフローが失敗すると、通常はリポジトリを管理・監視しているGitHubアカウントへメール通知が届きます。届かない場合は、GitHubの「Settings」→「Notifications」→「Actions」で、失敗時のメール通知設定を確認してください。

## 7. 運用でよくある作業

### メンバーを追加する

1. 「2. `members.json` を実際のメンバーで埋める」と同じ方法で発注者IDを調べます。
2. `members.json` の `members` 配列へ新しいメンバーを追加します。
3. 重複しない `id`、本人の `weeklyQuota`、参画日の `startedAt`、`"status": "active"` を設定します。
4. 発注者IDがまだ分からない場合は、`"employerId": null` として先に名簿へ登録できます。
5. `git add members.json`、`git commit -m "メンバーを追加"`、`git push` の順でGitHubへ送ります。
6. 必要ならActionsタブから手動実行し、すぐに初回データを取得します。

発注者IDが判明したら、`null` を発注者IDの数値へ書き換えてコミット・プッシュします。次回の巡回から自動的に対象になります。

### メンバーを休止・離脱させる

`members.json` からメンバーを削除せず、`status` だけを変更します。

- 一時休止：`"status": "paused"`
- 離脱：`"status": "left"`
- 垢BAN：`"status": "banned"`
- 復帰：`"status": "active"`

`paused` と `banned` は巡回対象外です。過去データは証跡なので、垢BAN時も `data/jobs.json` から消さないでください。変更後はコミットしてプッシュします。

### ノルマを変更する

対象メンバーの `weeklyQuota` を1以上の整数へ変更し、コミットしてプッシュします。次回の集計から新しいノルマが反映されます。すぐに反映したい場合はGitHub Actionsを手動実行してください。
