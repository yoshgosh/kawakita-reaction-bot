# kawakita-reaction-bot

Slackの各メッセージに対して、Jevを用いてリアクションを1つ選択し、自動付与するBotを実装する。

## コンセプト

真空ジェシカ川北をモチーフに、Slackメッセージに対して `まーごめ`、`ｷﾋﾞｼｲ`、`ﾓﾁﾛﾝ` などのリアクションから適切なものを選択する。

このコンセプトや上記の例示はREADME等のドキュメントに固定で記載してよい。

## システム構成

```text
Slack
  ↓ Events API / HTTP
Cloudflare Workers
  ↓
Jev
  ↓ 選択結果
Slack Web API / reactions.add
```

TypeScriptで実装する。

## 機能要件

- Slack AppのEvents APIでメッセージイベントをHTTP受信する
- Slack Signing Secretでリクエスト署名を検証する
- SlackのURL Verificationに対応する
- 人間による対象メッセージのみ処理し、Bot投稿は除外する
- SlackへのACKは速やかに返す
- Jevによる判定とリアクション付与はCloudflare Workersの `waitUntil()` で非同期実行する
- Jevへメッセージ内容と設定された指示を渡す
- Jevは定義済み候補からリアクションを1つ選択する
- 選択結果をSlack Web API `reactions.add` で元メッセージに付与する
- Slackの再送による意図しない重複処理を防止する
- JevまたはSlack APIでエラーが発生した場合は安全に終了する

## Jev設定

リアクション選択ロジックをアプリケーションコードにハードコードしない。

以下を独立した設定として注入できる設計にする。

- リアクションの選択肢
- 各リアクションの意味・判断基準
- Jevに与える指示文

アプリケーション本体は、特定のリアクション名・選択肢数・指示内容に依存しないこと。

JevのAPI・SDK仕様については推測で実装せず、現行の公式ドキュメントを確認して実装すること。

## インフラ・運用

- Cloudflare Workersで稼働
- DBなし
- 管理画面なし
- Slackメッセージ本文を永続保存しない
- Slack Bot Token、Slack Signing Secret、Jevの認証情報はCloudflare Secretsで管理する
- 小規模なSlackワークスペースで約1か月程度利用する想定
- 過剰なインフラや抽象化は避け、シンプルな構成にする

## Slack

Slack Appを1つ作成し、以下を利用する。

- Events API：メッセージ受信
- Web API `reactions.add`：リアクション付与
- Bot Token Scope：`reactions:write` および購読するメッセージイベントに必要な権限

リアクションに使用するSlackカスタム絵文字はワークスペース側に存在する前提とする。