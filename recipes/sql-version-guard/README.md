# 两位编辑者保存同一条记录

A 和 B 同时打开一条笔记，都看到版本 1。先预测：如果 A 先保存，B 能用自己打开时的旧草稿覆盖 A 吗？

需要 Python 3（含标准库 sqlite3）。在本目录运行。Windows 如只安装了 Python Launcher，可以将 `python3` 换成 `py -3`。

```sh
python3 lab.py
python3 lab.py --order BA --a-text 周一上线 --b-text 周五上线
```

两组实验各有一份真实的临时 SQLite 数据库。打开 `lab.py` 看 `save_drafts` 中的 `AND version = ?`。同样的两个独立连接、同样的编辑顺序，看看多这一个条件以后第二次更新匹配了几行，以及查询得到的最终正文和版本。

用 Node.js 22 或更高版本运行 `node verify.mjs`，重放两种顺序与一份临时的错误实现。错误实现必须正常执行且产生预设的错误结果。验收输出在 `verify-report.json`。实验控制的是读写顺序，无需线程或网络。
