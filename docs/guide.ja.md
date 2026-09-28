# planted 導入ガイド（試運転用）

リポジトリに仕込まれたコード（乗っ取られたアカウントから push されたもの）を、ビルドやエディタで動く前に見つけるためのツールです。このガイドは、組織に **段階的に試運転で入れる** 手順をまとめたものです。

- 対象: GitHub のリポジトリを管理する人・CI を触る人
- 所要時間: 手順 1 は 5 分、手順 2 は 1 リポジトリあたり 10 分
- 必要なもの: Node.js 20 以上と git（GitHub Actions の `ubuntu-latest` には最初から入っています）

---

## 1. 何を見つけるか、何をしないか

### 見つけるもの

| 手口 | 例 |
|---|---|
| 画面の外に押し出したコード | `postcss.config.mjs` の 1 行目の後ろに大量の空白、その先にローダー |
| 中身がプログラムの偽フォント・偽画像 | `public/fonts/fa-solid-900.woff2` の中身が JavaScript |
| フォルダを開くと勝手に走るエディタのタスク | `.vscode/tasks.json` の `runOn: folderOpen`、`.vscode/settings.json` の `task.allowAutomaticTasks` |
| ビルド設定で「取ってきて実行」 | `middleware.ts` や `*.config.ts` で `atob` / `fetch` の結果を `eval` |
| 危険な npm スクリプト | `postinstall` でダウンロードしたものをシェルに渡す、フォントを `node` で実行 |
| コミットの書き換えの痕跡 | 普段と違うタイムゾーンで、author と同じ時刻にされたコミット |
| コミットされた `.env` | ファイル名だけで判定（中身は読みません） |
| `.gitignore` の改ざん | `config.bat` を隠す行 |

### しないこと・できないこと

- **ファイルを実行しません。** 読むだけです。ブランチも checkout せずに git の中から直接読みます
- **ファイルの中身を結果に表示しません。** 検知した場所（ファイル名と行番号）だけを出します。ウイルス対策ソフトが結果を隔離するのを防ぐためです
- **push そのものは止められません。** GitHub.com では push を受け付ける前に検査する仕組みがないためです。止められるのは「その後のビルド・デプロイ・マージ」です
- **主な対象は JavaScript / TypeScript のプロジェクトです。** Python・Go・Java などのコードの中身の検査は限定的です（`.vscode`・偽フォント・`.env`・コミットの痕跡は言語に関係なく見ます）
- **未知の手口をすべて見つけられるわけではありません。** 既知の攻撃から、形の特徴を一般化して作っています

---

## 2. 試運転の進め方

いきなりビルドを止める設定にはせず、次の順で進めます。

| 手順 | やること | 目安 |
|---|---|---|
| 1 | 手元で一度、全ブランチを検査する | 初日 |
| 2 | 1 つのリポジトリの CI に **警告だけ** で入れる | 1〜2 週間 |
| 3 | 誤検知がなければ **ビルドを止める** 設定に切り替える | 手順 2 のあと |
| 4 | ほかのリポジトリに広げる | 手順 3 のあと |
| 5 | 夜間に全ブランチ・全 PR を検査する | 手順 4 と並行 |

---

## 3. 手順 1: 手元で全ブランチを検査する

```sh
git clone https://github.com/etoryoki/planted
git clone --mirror https://github.com/<組織>/<リポジトリ> target.git
node planted/src/cli.mjs --refs target.git
```

- `--mirror` で取得すると、全ブランチと **PR の ref**（`pull/123/head`）も含まれます。PR の ref は GitHub 上で消せないため、過去に感染したコミットが残っていることがあります
- checkout しないので、感染したコードが手元で動くことはありません
- 普段作業している clone に対して `node planted/src/cli.mjs --refs .` としても検査できます（その clone にある ref が対象）

### 結果の読み方

```
planted · /path/target.git · refs · 602 file(s) read
  [HIGH] vscode-autorun  .vscode/tasks.json:20  (blob d91d46bd)
      task runs automatically when the folder is opened, hidden from the user, ...
      in: feature/login, pull/41/head
```

| 表示 | 意味 |
|---|---|
| `[HIGH]` | 仕込まれたコードの可能性が高い。**そのブランチでビルドしない・エディタで開かない** |
| `[MEDIUM]` | 要確認。正当な理由があることもある（下の「誤検知の見分け方」） |
| `[INFO]` | 参考情報。既定では表示しない（`--min info` で表示） |
| `in:` | そのファイルがあるブランチ・PR。`history` は過去の履歴のどこか |
| 終了コード | HIGH があれば `1`、なければ `0`、エラーは `2` |

---

## 4. 手順 2: CI に「警告だけ」で入れる

`.github/workflows/planted.yml` を追加します。**ビルドは止めず**、結果を GitHub のジョブのまとめ画面（Summary）に出します。

```yaml
name: planted

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  planted:
    runs-on: ubuntu-latest
    continue-on-error: true   # 試運転中はビルドを止めない
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Check for planted code
        shell: bash
        run: |
          git clone --quiet https://github.com/etoryoki/planted "$RUNNER_TEMP/planted"
          git -C "$RUNNER_TEMP/planted" checkout --quiet <固定する SHA>
          { echo '### planted'; echo '```'; node "$RUNNER_TEMP/planted/src/cli.mjs" .; echo '```'; } | tee -a "$GITHUB_STEP_SUMMARY"
```

### 固定する SHA の決め方

`<固定する SHA>` には、planted の特定のコミットを入れます。ブランチ名（`main`）で取らないでください。planted 自体が乗っ取られた場合に、悪意ある変更がそのまま全リポジトリの CI に入ってしまうためです。

```sh
git ls-remote https://github.com/etoryoki/planted main
```

の先頭の 40 文字が、その時点の最新の SHA です。

### 試運転中に見ること

- 実行のたびに、Actions の画面の **Summary** に結果が出ます
- 警告が出たら、下の「誤検知の見分け方」で確認し、**誤検知ならファイル名・ルール名・理由をメモ** しておいてください（ファイルの中身は送らないでください）
- dependabot の PR でも動きます（トークンや secret は使いません）

---

## 5. 手順 3: ビルドを止める設定に切り替える

誤検知がなければ、`continue-on-error: true` を消し、ビルドのジョブが planted のジョブを待つようにします。

```yaml
jobs:
  planted:
    runs-on: ubuntu-latest
    steps:
      # （手順 2 と同じ）

  build:
    needs: planted      # planted が失敗したらビルドしない
    runs-on: ubuntu-latest
    steps:
      # 既存のインストール・ビルドの手順
```

- ビルドやデプロイが **別のワークフロー** にある場合は、そのワークフローに planted のジョブを足して `needs:` でつなぐのが確実です
- PR のマージを止めたい場合は、ブランチ保護（ruleset）の **Required status checks** に `planted` を追加します
- **Vercel などの外部サービスが push のたびに自動でビルドする場合、この設定では止まりません。** ビルドした時点でペイロードは動きます
  - Vercel の Deployment Checks は「本番のドメインへの切り替え」を止める機能で、**ビルド自体は走ります**。これだけでは足りません
  - 確実なのは、Git 連携の自動デプロイを止め（全ブランチ。プレビューも含む）、GitHub Actions の中で planted が通った後に `vercel deploy` する形です
  - `vercel.json` の `git.deploymentEnabled` や `ignoreCommand` で止める方法もありますが、`vercel.json` はリポジトリの中にあるため、乗っ取られたアカウントなら書き換えられます。設定はダッシュボード側で行ってください

---

## 6. 手順 5: 夜間に全ブランチ・全 PR を検査する

PR ごとの検査は「そのブランチ」しか見ません。攻撃では多数のブランチが一度に書き換えられるので、全体を定期的に検査します。

```yaml
name: planted-nightly

on:
  schedule:
    - cron: "0 18 * * *"   # 毎日 03:00（日本時間）
  workflow_dispatch:

permissions:
  contents: read

jobs:
  all-refs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Fetch every branch and PR
        run: git fetch --quiet --no-tags origin '+refs/heads/*:refs/remotes/origin/*' '+refs/pull/*/head:refs/remotes/pull/*'
      - name: Check every branch and PR
        shell: bash
        run: |
          git clone --quiet https://github.com/etoryoki/planted "$RUNNER_TEMP/planted"
          git -C "$RUNNER_TEMP/planted" checkout --quiet <固定する SHA>
          { echo '### planted (all refs)'; echo '```'; node "$RUNNER_TEMP/planted/src/cli.mjs" --refs .; echo '```'; } | tee -a "$GITHUB_STEP_SUMMARY"
```

- この検査はビルドをしないので、止める必要はありません。HIGH があればジョブが失敗し、GitHub から通知が届きます
- 失敗の通知は、スケジュールを最後に編集した人に届きます

### 既に分かっている検知を登録する（ベースライン）

消せない PR の ref に過去の感染が残っていると、夜間の検査が毎晩失敗し、そのうち誰も見なくなります。確認済みの検知を **ベースライン** に登録すると、**新しく出たものだけ** を知らせるようになります。

1. 手元で作る（手順 1 のミラーに対して）

   ```sh
   node planted/src/cli.mjs --refs target.git --write-baseline planted-baseline.json
   ```

2. 中身を **人が確認する**。1 件ずつ、どのルール・ファイル・ブランチ／PR か、なぜ既知として扱ってよいかを確かめます（ファイルの中身は入っていません）
3. リポジトリに `.github/planted-baseline.json` として置き、夜間のワークフローの最後の行を次に変える

   ```sh
   node "$RUNNER_TEMP/planted/src/cli.mjs" --refs . --baseline .github/planted-baseline.json
   ```

**ベースラインのしくみと注意**

- 登録の単位は「ルール + ファイル + 中身 + **見つかったブランチ／PR**」です。攻撃では同じファイルが多数のブランチに撒かれるため、**同じ中身でも新しいブランチに出たら、改めて知らせます**
- 実行のたびに「何件を既知として伏せたか」と「もう見つからなくなった登録」の件数を必ず表示します。伏せた件数が急に増えたら要注意です
- **ベースラインのファイル自体が狙われます。** 乗っ取られたアカウントは、自分のペイロードをベースラインに足して隠すこともできます。次のどちらかで守ってください
  - `.github/CODEOWNERS` に `/.github/planted-baseline.json @<管理者>` を書き、ruleset でコードオーナーのレビューを必須にする
  - ベースラインを別の（書き込める人を絞った）リポジトリに置き、夜間のワークフローでそこから取得する
- 手元のミラー（ブランチ名が `develop`）と CI の clone（`origin/develop`）の違いは、自動でそろえて比べます

---

## 6b. 組織の全リポジトリを 1 か所から夜間に検査する（推奨）

手順 2〜5 は「各リポジトリの CI に入れる」形です。これには 2 つの穴があります。

- CI のないリポジトリ（Java のプロジェクトなど）は検査されない
- 書き込み権限を持つ攻撃者は、リポジトリの中のワークフローを消せる

そこで、**組織の外にある 1 つのリポジトリ** から、組織の全リポジトリ・全ブランチ・全 PR を毎晩検査します。

### 準備（管理者が 1 回だけ）

1. **検査用の非公開リポジトリを作る**（例: 管理者個人の `planted-watch`）。組織のメンバーが書き込めない場所にします。検査結果とベースラインがここに置かれます
2. **読み取り専用のトークンを作る**: GitHub の Settings → Developer settings → Fine-grained personal access tokens
   - Resource owner: 組織
   - Repository access: All repositories
   - Permissions: **Contents: Read-only**（Metadata: Read-only は自動で付きます）。ほかの権限は付けない
   - 組織の設定でトークンの承認が必要な場合は、組織の管理者が承認します
3. 検査用リポジトリの Settings → Secrets and variables → Actions に、`PLANTED_TOKEN` という名前で登録する
4. [docs/org-watch.yml](org-watch.yml) を、検査用リポジトリの `.github/workflows/planted-org.yml` として置き、`<ORG>` と `<COMMIT_SHA>` を書き換える

### 最初のベースラインを作る

過去の感染が残っている組織では、最初に既知の検知を登録しておきます（しないと毎晩失敗します）。

```sh
git clone https://github.com/etoryoki/planted
# gh にログイン済みなら、その認証が使われます（トークンを直接扱う必要はありません）
node planted/src/cli.mjs --org <ORG> --cache .planted-cache --write-baseline-dir baselines
```

- `baselines/<リポジトリ名>.json` ができます。**1 件ずつ人が確認** してから、検査用リポジトリにコミットします
- 確認の目安は「7. 誤検知の見分け方」と「8. HIGH が出たときの初動」です。HIGH をベースラインに入れるのは、**消せない PR の ref など、片付けが済んだと確認できたものだけ** にしてください

### 運用

- Actions の画面から `planted-org` を手動で 1 回実行（Run workflow）して、結果を確認します
- 毎晩 03:00 に動き、**新しい HIGH が出たリポジトリがあればジョブが失敗** します。読み取れなかったリポジトリがあっても失敗します（黙って飛ばしません）
- 失敗の通知は、スケジュールを最後に編集した人に届きます。検査用リポジトリを **Watch** しておくと確実です
- 結果は、実行ごとの **Summary** に出ます。リポジトリごとに「何件を既知として伏せたか」も表示されます
- 全リポジトリのミラーは Actions のキャッシュに保存され、翌晩は差分だけを取得します（キャッシュは検査用リポジトリの中にだけ保存されます）

---

## 7. 誤検知の見分け方

| ルール | 正当なことがある例 | 確認すること |
|---|---|---|
| `hidden-after-blanks` | 自動生成・圧縮されたコード | そのファイルを人が書いたか。行の途中に大量の空白が必要な理由があるか |
| `fake-binary`（MEDIUM） | 拡張子と形式が違う本物のファイル | 画像ビューアやフォントとして開けるか（エディタで中身を開かない） |
| `config-exec` | ビルド設定で子プロセスを起動している | 誰がいつその行を入れたか（`git log -p -- <ファイル>`） |
| `vscode-autorun`（MEDIUM） | チームで決めた自動タスク | 実行するコマンドが既知のものか |
| `commit-timezone` | 出張先からのコミット | 本人に確認 |
| `committed-env-file` | 見本の値しか入っていない `.env` | 中身が本当に見本だけか（違えば鍵を差し替える） |

**迷ったら、HIGH は「感染」として扱ってください。**

---

## 8. HIGH が出たときの初動

1. **そのブランチでビルド・インストールをしない。エディタで開かない**
2. どのブランチ・PR に出たか（`in:` の行）と、ルール名・ファイル名を控える
3. そのブランチの最後のコミットの作者・日時を確認する（`git log -1 --format='%an %ae %ai | %cn %ci' <ブランチ>`）。作者が知らないと言う変更なら、アカウントの乗っ取りを疑う
4. 証拠を残してから直す: `git bundle create evidence.bundle --all`
5. 直し方は、改ざん前のコミットに戻す（`--force-with-lease` で）か、通常のコミットで悪性ファイルを消す
6. そのコミットで CI やデプロイが走っていないか、Actions とデプロイ先の履歴を確認する。走っていれば、その環境の秘密情報を差し替える

---

## 9. 手元の git フックで使う（任意）

pull した直後に検査する例です。`.git/hooks/post-merge` に置きます。

```sh
#!/bin/sh
node "$HOME/tools/planted/src/cli.mjs" . || echo "planted: 仕込まれたコードの可能性があります。ビルドする前に確認してください。"
```

- フックは各自の設定で、`--no-verify` などで簡単に外れます。**CI の代わりにはなりません**
- エディタ側でも、ユーザー設定に `"task.allowAutomaticTasks": "off"` を入れておくと、フォルダを開いたときの自動実行を防げます

---

## 10. planted の更新

- 固定している SHA を新しいものに変えるときは、**変更点を読んでから** 変えてください: `git -C planted log -p <今の SHA>..<新しい SHA>`
- 依存パッケージはありません。コードは約 800 行なので、一度に読める量です
- 脆弱性（planted 自体の問題）は、公開の Issue ではなく非公開で報告してください: [SECURITY.md](../SECURITY.md)

## 問い合わせ・誤検知の報告

GitHub の Issue（https://github.com/etoryoki/planted/issues）へ。**ファイルの中身や、社内のリポジトリ名・秘密情報は書かないでください。** ルール名・ファイル名の種類（例: `postcss.config.mjs`）・理由の文だけで十分です。
