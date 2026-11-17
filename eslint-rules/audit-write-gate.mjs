// `local/audit-write-gate` — the lint half of ADR-0021's type gate (#938).
//
// `MutatingDatabase` (db/connection) is a branded transaction handle that only
// `mutateInTx()` and `exemptFromAudit()` (services/mutate.ts) create. Writes on
// audited tables require it, so `tsc` rejects a write outside `mutate()`. Two
// things the compiler cannot see:
//   - `write`: a repository write on an audited table through a handle that is
//     not a `MutatingDatabase` parameter. Runs only with the `tables` option
//     (the repositories).
//   - `cast`: an assertion to `MutatingDatabase`, which forges the brand.
//
// Typed linting is off, so "is a `MutatingDatabase`" means: a type reference
// that resolves to the `MutatingDatabase` import from db/connection, and the
// table is a binding imported from db/schema. Exact, so a union
// (`MutatingDatabase | TxHandle`) or a local type of the same name fails.
//
// Options: { tables?: string[] } — Drizzle export names of the audited tables.

import path from 'node:path';

const SCHEMA_SOURCE = /(^|\/)db\/schema(\.[cm]?[jt]s)?$/;
const CONNECTION_SOURCE = /(^|\/)db\/connection(\.[cm]?[jt]s)?$/;
const BRAND = 'MutatingDatabase';
const WRITES = new Set(['insert', 'update', 'delete']);

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
        properties: { tables: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      write:
        'Audited-table write through a handle that is not a `MutatingDatabase` parameter. Take `MutatingDatabase`, so callers must be inside mutate(), or an exception named in exemptFromAudit (services/mutate.ts). ADR-0021.',
      cast: 'Assertion to `MutatingDatabase` forges the audit gate. Get the handle from mutate() / mutateInTx(), or name an exception in exemptFromAudit (services/mutate.ts). ADR-0021.',
    },
  },

  create(context) {
    const tables = context.options[0]?.tables;
    const audited = new Set(tables ?? []);
    const { sourceCode, filename } = context;

    function isBrand(typeNode) {
      if (typeNode?.type !== 'TSTypeReference' || typeNode.typeName.type !== 'Identifier')
        return false;
      const binding = importBinding(sourceCode.getScope(typeNode), typeNode.typeName.name);
      return (
        binding?.imported === BRAND && importsFrom(binding.declaration, CONNECTION_SOURCE, filename)
      );
    }

    function isAuditedTable(node) {
      const scope = sourceCode.getScope(node);
      if (node.type === 'Identifier') {
        const binding = importBinding(scope, node.name);
        return (
          audited.has(binding?.imported) &&
          importsFrom(binding.declaration, SCHEMA_SOURCE, filename)
        );
      }
      if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier') {
        const binding = importBinding(scope, node.object.name);
        return (
          binding?.namespace === true &&
          audited.has(node.property.name) &&
          importsFrom(binding.declaration, SCHEMA_SOURCE, filename)
        );
      }
      return false;
    }

    function isBrandedParameter(receiver) {
      if (receiver.type !== 'Identifier') return false;
      const def = findVariable(sourceCode.getScope(receiver), receiver.name)?.defs[0];
      return def?.type === 'Parameter' && isBrand(def.name.typeAnnotation?.typeAnnotation);
    }

    function checkCast(node) {
      if (isBrand(node.typeAnnotation)) context.report({ node, messageId: 'cast' });
    }

    return {
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,

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
