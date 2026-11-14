export const experiment = {
  recipeId: 'sql-version-guard',
  file: 'lab.py',
  runtime: 'python',
  checks: [
    { order: 'AB', expected: {
      plain: { body: '稿件 B', version: 3, matched: [1, 1] },
      guarded: { body: '稿件 A', version: 2, matched: [1, 0] },
    }},
    { order: 'BA', expected: {
      plain: { body: '稿件 A', version: 3, matched: [1, 1] },
      guarded: { body: '稿件 B', version: 2, matched: [1, 0] },
    }},
  ],
  negative: {
    from: 'sql += " AND version = ?"',
    to: 'sql += " AND ? IS NOT NULL"',
    order: 'AB',
    expected: {
      plain: { body: '稿件 B', version: 3, matched: [1, 1] },
      guarded: { body: '稿件 B', version: 3, matched: [1, 1] },
    },
  },
};
