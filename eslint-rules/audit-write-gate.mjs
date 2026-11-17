// `local/audit-write-gate` — the lint half of ADR-0021's type gate (#938).
//
// `MutatingDatabase` (db/connection) is a branded transaction handle that only
// `mutateInTx()` and `exemptFromAudit()` (services/mutate.ts) create. Writes on
// audited tables require it, so `tsc` rejects a write outside `mutate()`. Three
// things the compiler cannot see:
//   - `write`: a repository write on an audited table through a handle that is
//     not a `MutatingDatabase` parameter. Runs only with the `tables` option
//     (the repositories).
//   - `rawWrite`: SQL text that writes an audited table, unless it is an inline
//     drizzle `sql` template passed to `.execute()` on a `MutatingDatabase`
//     parameter. Every string and template is checked, so a statement composed
//     apart, `sql.raw()` or a driver query fails too, and so does SQL text
//     outside the repositories. Comments are stripped first. A target that is
//     neither a name nor a db/schema import (a call, a parameter, text appended
//     later) fails closed. Runs only with the `sqlTables` option.
//   - `cast`: an assertion to `MutatingDatabase`, which forges the brand;
//   - `never`: an assertion to `never`, which fits every parameter, so it
//     forges the brand too (#964).
//
// Typed linting is off, so "is a `MutatingDatabase`" means: a type reference
// that resolves to the `MutatingDatabase` import from db/connection, and the
// table is a binding imported from db/schema. Exact, so a union
// (`MutatingDatabase | TxHandle`) or a local type of the same name fails.
//
// Options: { tables?: string[], sqlTables?: string[] } — Drizzle export names
// and SQL names of the audited tables. An interpolated schema table counts by
// its export in snake case (`projectWorkers` → `project_workers`).

import path from 'node:path';

const SCHEMA_SOURCE = /(^|\/)db\/schema(\.[cm]?[jt]s)?$/;
const CONNECTION_SOURCE = /(^|\/)db\/connection(\.[cm]?[jt]s)?$/;
const BRAND = 'MutatingDatabase';
const WRITES = new Set(['insert', 'update', 'delete']);

// A raw-SQL write target: nothing but an `ONLY`, a schema or an opening quote up
// to the end of the text (a target appended later, by concatenation); or,
// optionally `public.`-qualified, a quoted name, a bare name, or an
// interpolation placeholder (\u0001<index>\u0001).
const TARGET = String.raw`(?:(?=(?:ONLY\b)?\s*(?:"?public"?\s*\.\s*)?"?\s*$)|(?:"?public"?\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][\w$]*)|\u0001(\d+)\u0001))`;
// Whitespace, or none before a quoted name or a placeholder.
const GAP = String.raw`(?:\s+|(?=["\u0001]))`;
// `FOR [NO KEY] UPDATE` locks rows and `DO UPDATE` is an upsert's conflict arm:
// neither names the table it writes.
const SINGLE_WRITE = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|(?<!\b(?:FOR\s+(?:NO\s+KEY\s+)?|DO\s+))UPDATE|DELETE\s+FROM|MERGE\s+INTO)` +
    GAP +
    String.raw`(?:ONLY\s+)?` +
    TARGET,
  'giu',
);
const TRUNCATE = new RegExp(
  String.raw`\bTRUNCATE` + GAP + String.raw`(?:TABLE` + GAP + ')?',
  'giu',
);
const LIST_ITEM = new RegExp(String.raw`(?:ONLY\s+)?` + TARGET + String.raw`(?:\s*\*)?`, 'iuy');
const LIST_SEPARATOR = /\s*,\s*/y;
const COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\//gu;

function snakeCase(name) {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Each write target in `text`, as `{ name }`, `{ placeholder }` (an index), or
 * `{}` when the target is not in the text.
 */
function writeTargets(rawText) {
  const text = rawText.replace(COMMENT, ' ');
  const targets = [];
  const push = (match) => {
    if (match[3] !== undefined) targets.push({ placeholder: Number(match[3]) });
    else if (match[2] !== undefined) targets.push({ name: match[2].toLowerCase() });
    // A quoted name with an interpolation inside is not a name.
    else if (match[1] !== undefined && !match[1].includes('\u0001'))
      targets.push({ name: match[1].toLowerCase() });
    else targets.push({});
  };
  for (const match of text.matchAll(SINGLE_WRITE)) push(match);
  for (const match of text.matchAll(TRUNCATE)) {
    let at = match.index + match[0].length;
    for (;;) {
      LIST_ITEM.lastIndex = at;
      const item = LIST_ITEM.exec(text);
      if (!item) break;
      push(item);
      LIST_SEPARATOR.lastIndex = LIST_ITEM.lastIndex;
      if (!LIST_SEPARATOR.test(text)) break;
      at = LIST_SEPARATOR.lastIndex;
    }
  }
  return targets;
}

// A relative import is resolved against the importing file.
function importsFrom(declaration, pattern, filename) {
  const value = declaration?.source?.value;
  if (typeof value !== 'string') return false;
  const source = value.startsWith('.')
    ? path.join(path.dirname(filename), value).split(path.sep).join('/')
    : value;
  return pattern.test(source);
}

function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

/** The import a name resolves to: `{ imported, namespace, declaration }`, or undefined. */
function importBinding(scope, name) {
  const def = findVariable(scope, name)?.defs[0];
  if (def?.type !== 'ImportBinding') return undefined;
  const spec = def.node;
  return {
    imported:
      spec.type === 'ImportSpecifier' ? (spec.imported.name ?? spec.imported.value) : undefined,
    namespace: spec.type === 'ImportNamespaceSpecifier',
    declaration: def.parent,
  };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Write audited tables only through a MutatingDatabase, which only mutate() mints.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          tables: { type: 'array', items: { type: 'string' } },
          sqlTables: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawWrite:
        'Raw-SQL write on an audited table outside an inline `sql` template passed to `.execute()` on a `MutatingDatabase` parameter. Write it inline there, in a repository, so callers must be inside mutate() or an exception named in exemptFromAudit (services/mutate.ts). ADR-0021.',
      write:
        'Audited-table write through a handle that is not a `MutatingDatabase` parameter. Take `MutatingDatabase`, so callers must be inside mutate(), or an exception named in exemptFromAudit (services/mutate.ts). ADR-0021.',
      cast: 'Assertion to `MutatingDatabase` forges the audit gate. Get the handle from mutate() / mutateInTx(), or name an exception in exemptFromAudit (services/mutate.ts). ADR-0021.',
      never:
        'Assertion to `never` fits every type, `MutatingDatabase` included, so it can forge the audit gate. Type the value instead; get a handle from mutate() / mutateInTx(), or name an exception in exemptFromAudit (services/mutate.ts). ADR-0021.',
    },
  },

  create(context) {
    const tables = context.options[0]?.tables;
    const audited = new Set(tables ?? []);
    const sqlTables = context.options[0]?.sqlTables;
    const auditedSql = new Set((sqlTables ?? []).map((name) => name.toLowerCase()));
    const { sourceCode, filename } = context;

    function isBrand(typeNode) {
      if (typeNode?.type !== 'TSTypeReference' || typeNode.typeName.type !== 'Identifier')
        return false;
      const binding = importBinding(sourceCode.getScope(typeNode), typeNode.typeName.name);
      return (
        binding?.imported === BRAND && importsFrom(binding.declaration, CONNECTION_SOURCE, filename)
      );
    }

    /** The db/schema export `node` names, or undefined when it names none. */
    function schemaExport(node) {
      const scope = sourceCode.getScope(node);
      if (node.type === 'Identifier') {
        const binding = importBinding(scope, node.name);
        return binding && importsFrom(binding.declaration, SCHEMA_SOURCE, filename)
          ? binding.imported
          : undefined;
      }
      if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier') {
        const binding = importBinding(scope, node.object.name);
        return binding?.namespace === true &&
          importsFrom(binding.declaration, SCHEMA_SOURCE, filename)
          ? node.property.name
          : undefined;
      }
      return undefined;
    }

    function isAuditedTable(node) {
      return audited.has(schemaExport(node));
    }

    function isDrizzleSqlTag(node) {
      if (node.type !== 'Identifier') return false;
      const binding = importBinding(sourceCode.getScope(node), node.name);
      return binding?.imported === 'sql' && binding.declaration?.source?.value === 'drizzle-orm';
    }

    // The one allowed shape: tx.execute(sql`…`) with `tx: MutatingDatabase`.
    function isBrandedExecute(template) {
      const tagged = template.parent;
      if (tagged?.type !== 'TaggedTemplateExpression' || !isDrizzleSqlTag(tagged.tag)) return false;
      const call = tagged.parent;
      if (call?.type !== 'CallExpression' || call.arguments[0] !== tagged) return false;
      const callee = call.callee;
      return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.name === 'execute' &&
        isBrandedParameter(callee.object)
      );
    }

    // A target that is neither a name nor a db/schema import cannot be checked.
    function writesAuditedTable(text, expressions = []) {
      return writeTargets(text).some((target) => {
        if (target.name !== undefined) return auditedSql.has(target.name);
        const expression = expressions[target.placeholder];
        const exported = expression && schemaExport(expression);
        return exported === undefined || auditedSql.has(snakeCase(exported));
      });
    }

    function checkRawSql(node, text, expressions) {
      if (!writesAuditedTable(text, expressions)) return;
      if (node.type === 'TemplateLiteral' && isBrandedExecute(node)) return;
      context.report({ node, messageId: 'rawWrite' });
    }

    function isBrandedParameter(receiver) {
      if (receiver.type !== 'Identifier') return false;
      const def = findVariable(sourceCode.getScope(receiver), receiver.name)?.defs[0];
      return def?.type === 'Parameter' && isBrand(def.name.typeAnnotation?.typeAnnotation);
    }

    function checkCast(node) {
      if (node.typeAnnotation.type === 'TSNeverKeyword')
        context.report({ node, messageId: 'never' });
      else if (isBrand(node.typeAnnotation)) context.report({ node, messageId: 'cast' });
    }

    return {
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,

      Literal(node) {
        if (sqlTables && typeof node.value === 'string') checkRawSql(node, node.value);
      },

      TemplateLiteral(node) {
        if (!sqlTables) return;
        const text = node.quasis
          .map(
            (quasi, i) =>
              (i === 0 ? '' : `\u0001${i - 1}\u0001`) + (quasi.value.cooked ?? quasi.value.raw),
          )
          .join('');
        checkRawSql(node, text, node.expressions);
      },

      CallExpression(node) {
        if (!tables) return;
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (!WRITES.has(callee.property.name)) return;
        const [table] = node.arguments;
        if (!table || !isAuditedTable(table)) return;
        if (!isBrandedParameter(callee.object)) context.report({ node, messageId: 'write' });
      },
    };
  },
};
