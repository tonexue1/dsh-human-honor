# 较早的响应会覆盖最后一次搜索吗？

先发搜索 A，再发 B。如果 B 的响应先回来，A 的响应后回来，界面最终应该采用哪个？本实验用 JavaScript Promise 接收结果，由你指定交付顺序。它不连接服务器，避免网络速度决定实验结果。

需要 Node.js 22 或更高版本。在本目录运行。

```sh
node lab.mjs --order BA
node lab.mjs --order AB --a-text 苹果 --b-text 梨
```

打开 `lab.mjs`，比较 `plain` 和 `guarded` 的更新逻辑。在返回顺序分别为 BA、AB 时，哪个结果保持对应最后发出的 B？

用 `node verify.mjs` 重放两种顺序，并在临时副本中移除请求编号判断。只有副本正常运行、出现旧结果覆盖新结果，反例才算命中。每次验收会更新 `verify-report.json`。
