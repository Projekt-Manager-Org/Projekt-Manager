// `local/no-direct-db-access` — database access belongs in
// src/server/repositories/ (spec §11.2, ARCHITECTURE.md; #937, #939).
//
// Reports, in each file the config applies it to:
//   - every value-position use of a binding imported from the Drizzle
//     schema (`db/schema`), named or through a namespace import;
//   - every `.execute(...)` / `.query(...)` call (Drizzle raw SQL, the pg
//     pool or client) and every relational query (`.query.<t>.findFirst`);
//   - every re-export of a schema table, which would let another module
//     reach the table without importing the schema.
//
// Each use counts separately on purpose: ESLint bulk suppressions count
// violations per file, so one report per import would freeze a file at
// one while new queries piled up inside it.
//
// Typed linting is off, so the rule cannot ask whether a schema export is a
// table. Non-table constants are listed in `allow`. Type positions
// (`typeof table.$inferSelect`, `import type`) are not access and never count.
//
// Options: { allow?: string[], queries?: boolean }. `queries: false` (the
// repositories) keeps only the re-export check.

import path from 'node:path';

const SCHEMA_SOURCE = /(^|\/)db\/schema(\.[cm]?[jt]s)?$/;
const QUERY_CALLS = new Set(['execute', 'query']);
const RELATIONAL_CALLS = new Set(['findFirst', 'findMany']);

// A relative import is resolved against the importing file, so `./schema.js`
// from inside db/ counts and a `schema.ts` elsewhere does not.
function isSchemaSource(node, filename) {
  if (node?.type !== 'Literal' || typeof node.value !== 'string') return false;
  const source = node.value.startsWith('.')
    ? path.join(path.dirname(filename), node.value).split(path.sep).join('/')
    : node.value;
  return SCHEMA_SOURCE.test(source);
}

function propertyName(member) {
  return member?.type === 'MemberExpression' &&
    !member.computed &&
    member.property.type === 'Identifier'
    ? member.property.name
    : undefined;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/**
 * Whether the node is part of an exported value (`export default users`,
 * `export const t = { users }`) rather than used inside an exported
 * function's body.
 */
function isExported(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (FUNCTION_TYPES.has(n.type)) return false;
    if (n.type === 'ExportDefaultDeclaration' || n.type === 'ExportNamedDeclaration') return true;
  }
  return false;
}

function inTypePosition(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'TSTypeQuery') return true;
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Keep database access inside src/server/repositories/.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
          queries: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      query:
        'Database access outside src/server/repositories/. Move it into the repository module for its entity or database-wide operation there. Do not regenerate the baseline (eslint-suppressions.json) to make this pass; see #937.',
      reexport:
        'Re-export of a database table. Tables stay inside src/server/repositories/; export functions that use them instead. See #937.',
    },
  },

  create(context) {
    const { allow = [], queries = true } = context.options[0] ?? {};
    const allowed = new Set(allow);
    const { sourceCode } = context;
    /** Local names bound to schema tables: named, default and namespace imports. */
    const tableNames = new Set();
    /** Import specifiers whose references are checked at Program:exit. */
    const specifiers = [];

    function reportReexport(node, name) {
      if (!allowed.has(name)) context.report({ node, messageId: 'reexport' });
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type' || !isSchemaSource(node.source, context.filename)) return;
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue;
          if (spec.type === 'ImportSpecifier') {
            const imported = spec.imported.name ?? spec.imported.value;
            if (allowed.has(imported)) continue;
          }
          tableNames.add(spec.local.name);
          specifiers.push(spec);
        }
      },

      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        for (const spec of node.specifiers ?? []) {
          if (spec.exportKind === 'type') continue;
          const local = spec.local.name ?? spec.local.value;
          if (node.source) {
            if (isSchemaSource(node.source, context.filename)) reportReexport(spec, local);
          } else if (tableNames.has(local)) {
            reportReexport(spec, '');
          }
        }
      },

      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && isSchemaSource(node.source, context.filename)) {
          context.report({ node, messageId: 'reexport' });
        }
      },

      CallExpression(node) {
        if (!queries) return;
        const name = propertyName(node.callee);
        if (QUERY_CALLS.has(name)) {
          context.report({ node: node.callee.property, messageId: 'query' });
        } else if (
          RELATIONAL_CALLS.has(name) &&
          propertyName(node.callee.object?.object) === 'query'
        ) {
          context.report({ node: node.callee.property, messageId: 'query' });
        }
      },

      'Program:exit'() {
        for (const spec of specifiers) {
          const isNamespace = spec.type === 'ImportNamespaceSpecifier';
          for (const variable of sourceCode.getDeclaredVariables(spec)) {
            for (const ref of variable.references) {
              const id = ref.identifier;
              if (ref.isValueReference === false || inTypePosition(id)) continue;
              // `export { users }` is ExportNamedDeclaration's to report.
              if (id.parent?.type === 'ExportSpecifier') continue;
              let use = id;
              if (
                isNamespace &&
                id.parent?.type === 'MemberExpression' &&
                id.parent.object === id
              ) {
                if (allowed.has(propertyName(id.parent))) continue;
                use = id.parent;
              }
              if (queries) {
                context.report({ node: id, messageId: 'query' });
              } else if (isExported(use)) {
                // A repository may use a table, not hand it out under
                // another name (`export const t = users`, `export default`).
                context.report({ node: id, messageId: 'reexport' });
              }
            }
          }
        }
      },
    };
  },
};
