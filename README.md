# Mermaid Lightbox

Obsidian で Mermaid 図を見やすくするシンプルなプラグインです。

- Mermaid 図をノートの幅に収め、横スクロールが出ないようにします
- リーディングビューで図をクリックすると、Obsidian 標準の画像拡大と同じ見た目・アニメーションで全画面表示します

*A tiny Obsidian plugin that fits Mermaid diagrams to the note width and opens them in a full-screen lightbox (matching Obsidian's built-in image lightbox) when clicked in reading view. No dependencies, no build step, no network access.*

## 機能

| 対象 | 動作 |
| --- | --- |
| すべてのビュー | Mermaid 図をノート幅に縮小表示（横スクロールなし） |
| リーディングビュー | 図をクリックすると全画面で拡大表示 |
| ライブプレビュー / ソースモード | 縮小表示のみ（クリックしても拡大しない） |

### 拡大表示中の操作

| 操作 | 動作 |
| --- | --- |
| マウスホイール / トラックパッドのピンチ | カーソル位置を中心に拡大・縮小（1〜10 倍） |
| ドラッグ（拡大中） | 図を移動 |
| ダブルクリック | 2.5 倍に拡大 / 元に戻す |
| `=` / `-` | 拡大 / 縮小 |
| `Esc`・× ボタン・背景クリック | 閉じる |
| 2 本指ピンチ（タッチ操作） | 拡大・縮小 |

## インストール

コミュニティプラグインストアには公開していないため、手動でインストールします。

1. [Releases](../../releases) から最新版の `manifest.json`・`main.js`・`styles.css` をダウンロードする
   （またはこのリポジトリをクローンする）
2. Vault 内に `.obsidian/plugins/mermaid-lightbox/` フォルダを作り、3 つのファイルを入れる
3. Obsidian の「設定 → コミュニティプラグイン」で制限モードをオフにし、「Mermaid Lightbox」を有効にする

## セキュリティ

- **外部依存ゼロ**：npm パッケージ・ビルドツール・CDN を一切使っていません。配布物は手書きの `main.js`・`styles.css`・`manifest.json` の 3 ファイルだけで、中身をそのまま読んで確認できます
- **通信なし**：ネットワークアクセス、テレメトリ、外部サービスとの連携は一切ありません
- **ノートを変更しない**：ファイルの読み書きは行わず、画面表示だけを扱います
- **安全な DOM 操作**：`innerHTML`・`eval` などは使わず、描画済みの SVG を `cloneNode` で複製して表示します。複製した SVG からは `<script>`・埋め込み要素・`on*` イベント属性・`javascript:` URL を取り除き、拡大画面内のリンクも無効化しています

## 補足

- 拡大表示には Obsidian 本体の画像ライトボックスの CSS クラス（`lightbox` など）を使っています。本体側にこのスタイルがない古いバージョンや、将来クラス名が変わった場合でも、最低限の表示が崩れないようフォールバックの CSS を同梱しています
- ダークテーマでは Obsidian が Mermaid 図に適用する色反転がそのまま反映されます

## ライセンス

[MIT](LICENSE)
