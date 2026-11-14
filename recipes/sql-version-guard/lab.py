"""实验：两位编辑者都打开 v1，一前一后保存。需要 Python 3 和 sqlite3。"""

import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory


def save_drafts(database, order, text, guarded):
    with closing(sqlite3.connect(database)) as a, closing(sqlite3.connect(database)) as b:
        a.execute("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT, version INTEGER)")
        a.execute("INSERT INTO note VALUES (1, '原稿', 1)")
        a.commit()

        editors = {"A": a, "B": b}
        versions = {
            name: editor.execute("SELECT version FROM note WHERE id = 1").fetchone()[0]
            for name, editor in editors.items()
        }
        sql = "UPDATE note SET body = ?, version = version + 1 WHERE id = 1"
        if guarded:
            sql += " AND version = ?"

        matched = []
        for name in order:
            values = (text[name], versions[name]) if guarded else (text[name],)
            with editors[name]:
                matched.append(editors[name].execute(sql, values).rowcount)
        body, version = a.execute("SELECT body, version FROM note WHERE id = 1").fetchone()
        return {"body": body, "version": version, "matched": matched}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--order", choices=("AB", "BA"), default="AB", help="保存顺序")
    parser.add_argument("--a-text", default="A 的草稿")
    parser.add_argument("--b-text", default="B 的草稿")
    parser.add_argument("--json", action="store_true")
    options = parser.parse_args()
    drafts = {"A": options.a_text, "B": options.b_text}
    with TemporaryDirectory() as directory:
        result = {
            name: save_drafts(Path(directory) / (name + ".db"), options.order, drafts, guarded)
            for name, guarded in [("plain", False), ("guarded", True)]
        }
    if options.json:
        print(json.dumps(result))
        return
    print("两位编辑者都读到 v1，保存顺序为 " + " → ".join(options.order))
    for name, label in [("plain", "仅按 ID 更新"), ("guarded", "按 ID 和原版本更新")]:
        row = result[name]
        print(f"{label}：依次匹配 {row['matched']} 行，最终为「{row['body']}」(v{row['version']})")


if __name__ == "__main__":
    main()
