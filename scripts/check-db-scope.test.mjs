import { describe, expect, it } from 'vitest';
import { dbScopeFindings } from './check-db-scope.mjs';

describe('database scope lint', () => {
  const rules = (source) => dbScopeFindings(source).map(({ rule }) => rule);

  it('accepts scoped, parameterized SQL and static fragments', () => {
    expect(
      rules(`
        const columns = 'name, id';
        withScope(pools.app, scope, (_, client) =>
          client.query(\`SELECT \${columns} FROM things WHERE name = $1\`, [name]));
      `),
    ).toEqual([]);
  });

  it('flags new direct app pool queries and checkouts through simple aliases', () => {
    expect(
      rules(`
        pools.app.query('SELECT name FROM things');
        const pool = pools['app'];
        await pool?.connect();
      `),
    ).toEqual(['direct app pool access', 'direct app pool access']);
  });

  it('flags request values embedded in SQL text, including query configurations', () => {
    expect(
      rules(`
        const text = \`SELECT name FROM things WHERE name = \${name}\`;
        client.query({ text });
        client.query('SELECT name FROM things ORDER BY ' + order);
      `),
    ).toEqual(['constructed SQL text', 'constructed SQL text']);
  });
});
