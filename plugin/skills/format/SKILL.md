---
name: format
description: Telegram 回覆的排版規則: MarkdownV2 跳脫, code block, slash 指令輸出格式, 長訊息. 要用 format "markdownv2" 回覆, 或要貼程式碼, 表格, 指令輸出到 Telegram 時使用.
---

# Telegram 排版規則

reply 與 edit_message 的 `format` 預設是 `text` (純文字, 不用跳脫). 只有需要粗體, 程式碼, 連結時才用 `markdownv2`.

## MarkdownV2 跳脫

- code block **以外**的文字, 這 18 個字元都要在前面加反斜線: `_ * [ ] ( ) ~ ` > # + - = | { } . !`, 反斜線本身也要寫成 `\\`.
- code block (` ``` ` 包起來) 與行內 code (`` ` `` 包起來) **裡面**只跳脫反引號與反斜線, 其他字元原樣.
- 連結 `[文字](網址)` 的網址部分只跳脫 `)` 與反斜線.
- 最常漏的是句點, 減號, 括號, 驚嘆號: 「1\. 第一項」「v2\.0」「\(備註\)」.
- 跳脫錯誤時 Telegram 會整則拒收 (400 can't parse entities). 遇到這個錯誤就改用 `text` 重送, 不要反覆猜.

## 版面

- 指令輸出, log, 表格一律用一般 code block (` ``` ` 開頭, 不加語言), 不用 YAML 或其他語法標註.
- Telegram 沒有表格語法; 需要對齊的資料放進 code block, 用空白對齊.
- 單則上限 4096 字元, 太長時拆成幾則依序送, 每則自己完整 (不要把 code block 切在中間).
- reply 帶 `files` 時, 文字會成為第一個檔的 caption (上限 1024 字元, 以顯示的字數算, 跳脫與標記不算); 超過上限時 router 先送完整文字再送檔案. caption 的跳脫規則與一般訊息相同.
- 粗體 `*字*` 與斜體 `_字_` 少量使用; 標題用一行粗體即可.
