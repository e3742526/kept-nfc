// Guard the request-role boundary and raw SQL text construction. This check recognizes direct
// calls and simple local aliases. Review still needs to follow values across function calls.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { parseSync, traverse } = requireFromWeb('@babel/core');

function initializer(path) {
  if (path.isTSAsExpression() || path.isTSNonNullExpression()) {
    return initializer(path.get('expression'));
  }
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (binding?.constant && binding.path.isVariableDeclarator() && binding.path.node.init) {
      const init = binding.path.get('init');
      // Only follow earlier declarations. Besides matching typical SQL aliases, this prevents
      // cycles in unused or invalid source.
      if (init.node.end < path.node.start) return initializer(init);
    }
  }
  return path;
}

function staticText(path) {
  const value = initializer(path);
  if (value.isStringLiteral() || value.isNumericLiteral()) return true;
  if (value.isTemplateLiteral()) return value.get('expressions').every(staticText);
  if (value.isBinaryExpression({ operator: '+' })) {
    return staticText(value.get('left')) && staticText(value.get('right'));
  }
  if (value.isConditionalExpression()) {
    return staticText(value.get('consequent')) && staticText(value.get('alternate'));
  }
  return false;
}

function dynamicText(path) {
  const value = initializer(path);
  if (value.isObjectExpression()) {
    return value
      .get('properties')
      .flatMap((prop) =>
        prop.isObjectProperty() &&
        (prop.get('key').isIdentifier({ name: 'text' }) ||
          prop.get('key').isStringLiteral({ value: 'text' }))
          ? dynamicText(prop.get('value'))
          : [],
      );
  }
  if (value.isConditionalExpression()) {
    return [...dynamicText(value.get('consequent')), ...dynamicText(value.get('alternate'))];
  }
  return (value.isTemplateLiteral() || value.isBinaryExpression({ operator: '+' })) &&
    !staticText(value)
    ? [value]
    : [];
}

function memberName(node) {
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return '';
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return node.property.type === 'StringLiteral' ? node.property.value : '';
}

export function dbScopeFindings(source) {
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['typescript'] },
  });
  const findings = [];
  function call(path) {
    const callee = path.get('callee');
    const method = memberName(callee.node);
    if (method !== 'query' && method !== 'connect') return;
    const object = initializer(callee.get('object'));
    const [arg] = path.get('arguments');
    const record = (rule, node, code = source.slice(node.start, node.end)) =>
      findings.push({
        rule,
        line: node.loc.start.line,
        code,
      });
    if (memberName(object.node) === 'app') {
      const sql = method === 'query' && arg ? initializer(arg) : null;
      record(
        'direct app pool access',
        path.node,
        sql?.isStringLiteral() ? sql.node.value : undefined,
      );
    }
    if (method === 'query' && arg) {
      for (const sql of dynamicText(arg)) record('constructed SQL text', sql.node);
    }
  }
  traverse(ast, { CallExpression: call, OptionalCallExpression: call });
  return findings;
}

function main() {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps/server/src'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const findings = files.flatMap((file) =>
    dbScopeFindings(readFileSync(file, 'utf8')).map((finding) => ({ file, ...finding })),
  );
  const directAccess = {
    // Public entry points that have no session: bounded invite doors and a liveness probe.
    'accounts/sign-up.ts': 'SELECT kept.claim_invite($1, $2) AS ok',
    'http/health.ts': 'SELECT 1',
    'invites/routes.ts': 'SELECT * FROM kept.invite_preview($1)',
  };
  const sqlByFile = new Map();
  const remaining = findings.filter(({ file, rule, code }) => {
    file = file.slice('apps/server/src/'.length);
    if (rule === 'direct app pool access') {
      const expected = directAccess[file];
      if (expected !== code) return true;
      delete directAccess[file];
      return false;
    }
    const fragments = sqlByFile.get(file) ?? [];
    fragments.push(code);
    sqlByFile.set(file, fragments);
    return false;
  });
  // Freeze existing compositions for review. Hash each file’s multiset so adding a duplicate
  // is visible, while moving a function within a file does not invalidate its entry.
  const observed = Object.fromEntries(
    [...sqlByFile]
      .sort()
      .map(([file, fragments]) => [
        file,
        createHash('sha256').update(JSON.stringify(fragments.sort())).digest('hex').slice(0, 16),
      ]),
  );
  if (process.argv.includes('--print-baseline')) {
    console.log(JSON.stringify(observed, null, 2));
    return;
  }
  const baseline = JSON.parse(readFileSync(new URL('./db-sql-baseline.json', import.meta.url)));
  const changedFiles = new Set(
    [...new Set([...Object.keys(baseline), ...Object.keys(observed)])].filter(
      (file) => baseline[file] !== observed[file],
    ),
  );
  for (const { file, line, rule } of remaining) console.error(`${file}:${line} ${rule}`);
  for (const file of changedFiles)
    console.error(`apps/server/src/${file}: constructed SQL changed`);
  if (remaining.length || changedFiles.size) {
    console.error(
      'Use withScope() for app access and bind values with $n. Review SQL fragments before updating the baseline.',
    );
    process.exitCode = 1;
  } else {
    console.log(`check-db-scope: ${files.length} files checked`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
