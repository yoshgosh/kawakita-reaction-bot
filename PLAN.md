# kawakita-reaction-bot 実装計画

## 1. 目的

Slack App が参加している会話の通常投稿を受信し、TypeSafe AI の Jev によって定義済み候補からリアクションを1つ選び、元のメッセージへ自動付与する。

本計画の承認を得るまで、アプリケーションの実装は開始しない。

## 2. 確定事項

### 実行環境

- TypeScriptで実装する。
- Cloudflare WorkersのES Modules形式で稼働させる。
- DB、永続キュー、管理画面は設けない。
- 小規模なSlackワークスペースで約1か月利用する想定とする。

### 対象となるSlack会話

次の4種類を対象とする。いずれもSlack Appが参加している会話だけが対象となる。

| 会話 | Slackイベント | 必要なBot Token Scope |
| --- | --- | --- |
| 公開チャンネル | `message.channels` | `channels:history` |
| 非公開チャンネル | `message.groups` | `groups:history` |
| ユーザーとBotの1対1 DM | `message.im` | `im:history` |
| Botを含む複数人DM | `message.mpim` | `mpim:history` |

リアクション付与には、上記に加えて `reactions:write` を使用する。

Botが自ら会話へ参加・作成する機能は実装せず、`channels:join`、`im:write`、`mpim:write` は要求しない。

### 対象メッセージ

次の条件をすべて満たす投稿だけを対象とする。

- `event.type` が `message`
- `channel_type` が `channel`、`group`、`im`、`mpim` のいずれか
- 人間による投稿で、`user` が存在する
- `bot_id` と `app_id` が存在しない
- `subtype` が存在しない通常投稿
- `thread_ts` が存在しないルート投稿
- `text` が空白だけではない

スレッド返信、編集、削除、ファイル共有、チャンネル参加通知、Bot投稿、その他のsubtype付き投稿は処理しない。

### Slack再送

- Slack署名の検証後、`X-Slack-Retry-Num` があるイベントは処理せずHTTP 200を返す。
- 永続ストレージは追加しない。
- この方式は重複リアクション防止を優先し、初回配信がWorkerへ届かず再送だけが届いた場合には処理されない、at-most-once寄りの動作とする。
- Slack APIの `already_reacted` は処理済みとして正常終了する。

### Jev

- TypeSafe AIのHTTP APIをSDKなしで直接呼び出す。
- エンドポイントは `POST https://api.typesafe.ai/v1/systemone` とする。
- モデルは `jev-1.13.0` に固定する。
- Slack本文を `state` として送信する。
- 質問形式には `choice` を使用する。
- リアクションの判断指示を `instructions`、候補IDと意味・判断基準を `criteria` として送信する。
- 返された `answers.reaction.choice` が設定済み候補IDに含まれる場合だけSlack APIを呼び出す。
- 429または529に限り、`Retry-After` を尊重した短い再試行を最大1回行う。

## 3. 設定設計

リアクション選択ロジックをアプリケーションコードから分離し、Cloudflare Workersの非秘密環境変数として注入する。

想定する設定構造は次のとおり。

```json
{
  "instruction": "Slackメッセージに対して、最も自然なリアクションを1つ選んでください。\n\n- **まーごめ**：謝罪・ミス・やらかし・気まずさ\n- **ｷﾋﾞｼｲ**：困難・問題・驚き・つらい状況\n- **ﾓﾁﾛﾝ**：肯定・同意・了承・前向きな返答\n\n単語ではなく、メッセージ全体の意味で判断してください。",
  "options": [
    {
      "id": "maagome",
      "slackEmoji": "maagome_kawakita",
      "description": "謝罪・ミス・やらかし・気まずさ"
    },
    {
      "id": "kibishii",
      "slackEmoji": "kibishii_kawakita",
      "description": "困難・問題・驚き・つらい状況"
    },
    {
      "id": "mochiron",
      "slackEmoji": "mochiron_kawakita",
      "description": "肯定・同意・了承・前向きな返答"
    }
  ]
}
```

- `id` はJevのChoice候補として使う内部識別子とする。
- `slackEmoji` はSlackの `reactions.add` に渡す絵文字名とする。
- `description` はJevへ渡す判断基準とする。
- 候補数や候補名にアプリケーションコードを依存させない。
- 設定JSONの構文、必須フィールド、IDと絵文字名の重複を処理前に検証する。
- 内部IDは `maagome`、`kibishii`、`mochiron` とする。
- Slack絵文字名は `maagome_kawakita`、`kibishii_kawakita`、`mochiron_kawakita` とする。
- 指示文と各候補の説明は、上記設定例の内容を使用する。

秘密情報はCloudflare Secretsで管理する。

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `TYPESAFE_API_KEY`

ローカル開発用の実値は `.dev.vars` に置き、Git管理しない。リポジトリにはキー名だけを示す `.dev.vars.example` を含める。

## 4. HTTP処理フロー

1. 指定したSlack Events API用パスへのPOSTだけを受け付ける。
2. JSON解析前の生リクエスト本文を保持する。
3. `X-Slack-Request-Timestamp` が現在時刻から5分以内であることを確認する。
4. `v0:{timestamp}:{rawBody}` をSlack Signing SecretでHMAC-SHA256署名し、`X-Slack-Signature` と定数時間比較する。
5. 署名不正はHTTP 401、不正な本文はHTTP 400で終了する。
6. 署名検証済みの `url_verification` にはchallengeを返す。
7. 再送ヘッダー付きイベントには、外部APIを呼ばずHTTP 200を返す。
8. 対象外イベントにはHTTP 200を返す。
9. 対象イベントはJev判定とリアクション付与を `ctx.waitUntil()` に登録し、直ちにHTTP 200を返す。
10. バックグラウンド処理の失敗は外側で捕捉し、未処理のPromise rejectionを発生させない。

## 5. バックグラウンド処理

1. 注入されたリアクション設定を検証する。
2. Slack本文だけをTypeSafe AIへ送信する。SlackのユーザーID、氏名、チャンネルID、チャンネル名、ワークスペースID、タイムスタンプは送信しない。
3. JevのHTTPステータスとレスポンス構造を検証する。
4. 選択された候補IDを設定中の `slackEmoji` へ変換する。
5. Slack Web API `reactions.add` へ `channel`、元投稿の `ts`、絵文字名を送信する。
6. `ok: true` または `already_reacted` で正常終了する。
7. JevまたはSlack APIでエラーが起きた場合は、安全に終了してリアクションを追加しない。

## 6. データ保護とログ

- Slackメッセージ本文をファイル、DB、KV、キャッシュへ保存しない。
- メッセージ本文、認証情報、TypeSafeへの完全なリクエストをログへ出力しない。
- ログには処理段階、Slackの `event_id`、外部API名、HTTPステータス、正規化したエラー種別だけを記録する。
- TypeSafeへ送るデータはメッセージ本文だけに限定する。
- READMEに、Bot参加中の会話本文がリアクション選択のためTypeSafe AIへ送信されることを明記する。
- READMEに、機密性の高い会話へBotを追加しない運用上の注意を記載する。

## 7. 想定ファイル構成

```text
.
├── .dev.vars.example
├── .gitignore
├── HANDOVER.md
├── PLAN.md
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── wrangler.jsonc
├── src
│   ├── config.ts
│   ├── index.ts
│   ├── slack.ts
│   └── typesafe.ts
└── test
    ├── config.spec.ts
    ├── slack.spec.ts
    ├── typesafe.spec.ts
    └── worker.spec.ts
```

責務は次のように分ける。

- `index.ts`: HTTPルーティング、ACK、`waitUntil()` 登録
- `config.ts`: 環境変数の型定義とリアクション設定検証
- `slack.ts`: 署名検証、イベント判定、`reactions.add`
- `typesafe.ts`: Jevリクエスト生成、通信、レスポンス検証

小規模運用のため、これ以上のレイヤーやDIフレームワークは追加しない。

## 8. 実装順序

1. npmを使ったCloudflare Workersプロジェクトの最小構成を追加する。
2. 環境変数の型と設定検証を実装する。
3. Slack署名検証とURL Verificationを実装する。
4. 4種類の会話と通常ルート投稿のフィルタリングを実装する。
5. 即時ACKと `waitUntil()` の処理分離を実装する。
6. TypeSafe AI Choice呼び出しとレスポンス検証を実装する。
7. Slack `reactions.add` 呼び出しを実装する。
8. エラー処理と本文を含まないログを実装する。
9. Worker実行環境上のテストを追加する。
10. READMEとSlack App設定手順を作成する。

## 9. 検証計画

Cloudflare Workers公式のVitest連携を使用し、外部通信はモックする。

### Slack受信

- 正しい署名を受理する。
- 改ざん本文、不正署名、5分を超えたタイムスタンプを拒否する。
- URL Verificationへchallengeを返す。
- 再送ヘッダー付きイベントをACKのみで終了する。
- 公開、非公開、1対1 DM、複数人DMの通常投稿を受理する。
- Bot投稿、subtype付き投稿、スレッド返信、空本文を除外する。
- Jev処理の完了を待たずにHTTP 200を返す。

### Jev

- 設定からChoiceリクエストを生成する。
- `jev-1.13.0` を指定する。
- 正常な候補をSlack絵文字名へ変換する。
- 候補外、欠損、不正JSONを安全に拒否する。
- 429と529だけを最大1回再試行する。

### Slackリアクション

- 選択した絵文字を元投稿の `channel` と `ts` へ付与する。
- `already_reacted` を正常終了として扱う。
- Slack APIエラー時に例外を外へ漏らさない。

### データ保護

- TypeSafeへのリクエストにSlack本文以外のイベント情報を含めない。
- ログ処理へ本文や秘密情報を渡さない。

### 完了時に実行する確認

- 型チェック
- テスト一式
- Wranglerによるdry-runまたはデプロイ前ビルド
- Git差分の秘密情報検査

## 10. 受け入れ条件

- 4種類の対象会話にある人間の通常ルート投稿へ、設定候補からリアクションが1つ付く。
- スレッドおよび対象外投稿にはリアクションが付かない。
- SlackへのACKがJevとSlack Web APIの完了を待たない。
- Slack署名が検証され、古いリクエストが拒否される。
- Slack再送によるJevの再実行と異なるリアクションの追加を防止できる。
- 候補、判断基準、指示文をコード変更なしで差し替えられる。
- Slack本文が永続保存またはログ出力されない。
- JevまたはSlack APIの失敗時にWorkerが安全に終了する。
- 型チェック、テスト、ビルドが成功する。

## 11. Slack App・Cloudflare設定ドキュメントの方針

Slack Appの作成・権限設定、Cloudflare Workersの作成・Secrets登録・デプロイ、TypeSafe APIキーの発行は実行せず、ユーザーが行うための手順をREADMEに記載する。

手順を作成するときは、その時点の公式ドキュメントを再確認し、公式が新規プロジェクト向けに推奨する現行方式を採用する。ブログ記事、非公式記事、古いサンプルを根拠にしない。

### Slack

- `docs.slack.dev` の現行ドキュメントとApp Manifestリファレンスを基準にする。
- 再利用・レビュー可能なSlack App Manifestの例をリポジトリへ追加する。
- 初期Manifestには必要最小限のBot Token Scopeだけを記載し、Request URLとイベント購読は含めない。SlackはBotイベントを設定する時点でRequest URLまたはSocket Modeを要求するためである。
- App作成、ワークスペースへのインストール、Workerデプロイ、実Request URLと4種類のメッセージイベントの追加、URL Verification、会話へのBot追加の順に説明する。
- Slack側で仕様変更や廃止予定が確認された場合は、新方式を採用し、READMEに確認日と公式リンクを記載する。

### Cloudflare Workers

- Cloudflare公式ドキュメントが新規プロジェクトに推奨する `wrangler.jsonc` を構成の正本とする。
- Workerの型は旧来の固定型パッケージを前提にせず、`wrangler types` でcompatibility dateと設定に対応する型を生成する。
- テストには旧 `@cloudflare/vitest-pool-workers` ではなく、現行推奨の `@cloudflare/vitest-plugin` を使用する。
- 必須Secretsは `wrangler.jsonc` の `secrets.required` に宣言し、デプロイ前に不足を検出できるようにする。
- Secrets登録、ローカル用 `.dev.vars`、型生成、開発サーバー、検証、デプロイの順に説明する。
- `wrangler secret put` が即時に新バージョンをデプロイするなど、実行時点のCLI挙動を公式ドキュメントで再確認して注意事項を記載する。
- READMEに確認日とCloudflare公式リンクを記載する。

### TypeSafe AI

- `docs.typesafe.ai` の現行APIリファレンスを基準にする。
- APIキー発行、Secret登録、利用モデル、Choiceリクエストの確認方法を説明する。
- 実装時点で `jev-1.13.0` の提供状況とAPI仕様を再確認する。互換性に影響する変更がある場合は、勝手に別モデルへ変更せずユーザーへ確認する。

## 12. データ取扱いに関する決定

TypeSafeの一般向けプライバシーポリシーでは、入力をモデルの学習・ファインチューニングには使用しない一方、サービス提供等に合理的に必要な期間、入力を含む個人データを保持する可能性がある。通常利用でゼロデータ保持が保証される前提にはしない。

本プロジェクトでは、ゼロデータ保持の契約・プランを事前確認せず、この条件のまま約1か月の利用を進める。

## 13. 実装前の未決事項

現時点で未決事項はない。リアクション候補、内部ID、Slack絵文字名、Jevへの指示文は第3節で確定済み。

## 14. 実装開始条件

次の条件がそろった後、ユーザーの明示的な承認を受けて実装を開始する。

1. 本計画の内容が承認されている。
2. ユーザーが実装開始を明示的に指示している。

実装前には、Slack・Cloudflare・TypeSafe AIの公式ドキュメントと、各設定手順の最新状況を再確認する。
