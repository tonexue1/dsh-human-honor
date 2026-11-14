export const experiment = {
  recipeId: 'js-latest-request',
  file: 'lab.mjs',
  runtime: 'node',
  checks: [
    { order: 'BA', expected: { received: ['B', 'A'], plain: '稿件 A', guarded: '稿件 B' } },
    { order: 'AB', expected: { received: ['A', 'B'], plain: '稿件 B', guarded: '稿件 B' } },
  ],
  negative: {
    from: 'if (id === latest) guarded = value;',
    to: 'guarded = value;',
    order: 'BA',
    expected: { received: ['B', 'A'], plain: '稿件 A', guarded: '稿件 A' },
  },
};
