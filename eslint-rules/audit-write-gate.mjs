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
//   - Forging the brand (#964), in every file the rule runs on:
//     - `position`: `MutatingDatabase` anywhere but as the exact type of a
//       function parameter (not an overloaded method's). A variable, return
//       type, type guard, overload, alias, re-export, field or container can
//       label an unbranded handle;
//     - `cast`: an assertion to a type containing it;
//     - `never`: `never`, or a same-file alias, union or intersection that
//       reduces to it, as an assertion, a type guard or an overload's return;
//     - `opaqueCast`: an assertion to a type lint cannot resolve: a type
//       parameter only a caller's inference fixes, `typeof`, `infer`,
//       `Parameters<…>`, `ReturnType<…>` ….
//
// Typed linting is off, so "is a `MutatingDatabase`" means: a type reference
// that resolves to the `MutatingDatabase` import from db/connection (named, a
// namespace member or an `import()` type), and the table is a binding
// imported from db/schema. A write's parameter must be exactly that, so a
// union (`MutatingDatabase | TxHandle`) or a local type of the same name
// fails. Out of reach, all deliberate: types from files the rule skips
// (services/mutate.ts, tests); `any` from a library call; method
// bivariance (a subclass override, a `this` parameter); types computing to
// `never` (`'a' & 'b'`, `Extract<…>`); and a type read off a value used
// outside an assertion (`x is Parameters<typeof f>[0]`).
//
// Options: { tables?: string[], sqlTables?: string[] } — Drizzle export names
// and SQL names of the audited tables. An interpolated schema table counts by
// its export in snake case (`projectWorkers` → `project_workers`).

import path from 'node:path';

const SCHEMA_SOURCE = /(^|\/)db\/schema(\.[cm]?[jt]s)?$/;
const CONNECTION_SOURCE = /(^|\/)db\/connection(\.[cm]?[jt]s)?$/;
const BRAND = 'MutatingDatabase';
// Global utility types that read a type off a value the rule cannot type.
const VALUE_TYPES = new Set(['Parameters', 'ConstructorParameters', 'ReturnType', 'InstanceType']);
const RUNTIME_FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);
// Keyword types no value has two of at once: their intersection is `never`.
const PRIMITIVES = new Set([
  'TSStringKeyword',
  'TSNumberKeyword',
  'TSBooleanKeyword',
  'TSBigIntKeyword',
  'TSSymbolKeyword',
  'TSNullKeyword',
  'TSUndefinedKeyword',
]);
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
      position:
        '`MutatingDatabase` may only be the exact type of a function parameter, which its caller fills from mutate() / mutateInTx() or an exception named in exemptFromAudit (services/mutate.ts). Anywhere else (a variable, return type, type guard, alias, field or container) it can label an unbranded handle. ADR-0021.',
      cast: 'Assertion to `MutatingDatabase`, or to a type containing it, forges the audit gate. Get the handle from mutate() / mutateInTx(), or name an exception in exemptFromAudit (services/mutate.ts). ADR-0021.',
      never:
        "`never` (or a type reducing to it) as an assertion, a type guard or an overload's return fits every type, `MutatingDatabase` included, so it can forge the audit gate. Type the value instead; get a handle from mutate() / mutateInTx(), or name an exception in exemptFromAudit (services/mutate.ts). ADR-0021.",
      opaqueCast:
        'Assertion to a type lint cannot resolve (a type parameter, `typeof`, `infer`, `Parameters<…>`, `ReturnType<…>` …) can stand for a `MutatingDatabase`. Assert to a named type; get a handle from mutate() / mutateInTx(), or name an exception in exemptFromAudit (services/mutate.ts). ADR-0021.',
    },
  },

  create(context) {
    const tables = context.options[0]?.tables;
    const audited = new Set(tables ?? []);
    const sqlTables = context.options[0]?.sqlTables;
    const auditedSql = new Set((sqlTables ?? []).map((name) => name.toLowerCase()));
    const { sourceCode, filename } = context;

    function isBrand(typeNode) {
      return (
        typeNode?.type === 'TSTypeReference' &&
        typeNode.typeName.type === 'Identifier' &&
        isBrandName(typeNode.typeName.name, sourceCode.getScope(typeNode))
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

    function isBrandName(name, scope) {
      const binding = importBinding(scope, name);
      return (
        binding?.imported === BRAND && importsFrom(binding.declaration, CONNECTION_SOURCE, filename)
      );
    }

    function isConnectionNamespace(name, scope) {
      const binding = importBinding(scope, name);
      return (
        binding?.namespace === true && importsFrom(binding.declaration, CONNECTION_SOURCE, filename)
      );
    }

    /** Whether `node` names the brand: by name, as a namespace member or as an `import()` type. */
    function namesBrand(node) {
      if (node.type === 'TSImportType') {
        return (
          node.qualifier?.type === 'Identifier' &&
          node.qualifier.name === BRAND &&
          importsFrom(node, CONNECTION_SOURCE, filename)
        );
      }
      const name = node.type === 'TSTypeReference' ? node.typeName : node.expression;
      return isBrandEntity(name, sourceCode.getScope(node));
    }

    /** Whether the entity name `name` (`M`, `ns.M`) resolves to the brand. */
    function isBrandEntity(name, scope) {
      if (name?.type === 'Identifier') return isBrandName(name.name, scope);
      if (name?.type !== 'TSQualifiedName' && name?.type !== 'MemberExpression') return false;
      const left = name.left ?? name.object;
      const right = name.right ?? name.property;
      return (
        left.type === 'Identifier' &&
        right.name === BRAND &&
        isConnectionNamespace(left.name, scope)
      );
    }

    /** Whether any node in the subtree `node` satisfies `test`. */
    function someNode(node, test) {
      if (!node || typeof node.type !== 'string') return false;
      if (test(node)) return true;
      return (sourceCode.visitorKeys[node.type] ?? []).some((key) =>
        [node[key]].flat().some((child) => someNode(child, test)),
      );
    }

    const isNamedReference = (name) => (n) =>
      n.type === 'TSTypeReference' && n.typeName.type === 'Identifier' && n.typeName.name === name;

    /**
     * Whether the type `node` mentions a type parameter its function takes
     * from no parameter, so only a caller's inference fixes it.
     */
    function hasFreeTypeParameter(node) {
      return someNode(node, (n) => {
        if (n.type !== 'TSTypeReference' || n.typeName.type !== 'Identifier') return false;
        const def = findVariable(sourceCode.getScope(n), n.typeName.name)?.defs[0];
        if (def?.node.type !== 'TSTypeParameter') return false;
        const owner = def.node.parent.parent;
        return (
          RUNTIME_FUNCTIONS.has(owner.type) &&
          !owner.params.some((param) => someNode(param, isNamedReference(n.typeName.name)))
        );
      });
    }

    /** Whether `fn` implements a class method that has overload signatures. */
    function isOverloadedMethod(fn) {
      const method = fn.parent;
      if (method?.type !== 'MethodDefinition') return false;
      const key = sourceCode.getText(method.key);
      return method.parent.body.some(
        (other) =>
          other !== method &&
          other.type === 'MethodDefinition' &&
          other.value.type === 'TSEmptyBodyFunctionExpression' &&
          other.static === method.static &&
          sourceCode.getText(other.key) === key,
      );
    }

    /** `cast` or `opaqueCast` for a name in a type, following same-file declarations. */
    function forgedByName(identifier, seen) {
      const variable = findVariable(sourceCode.getScope(identifier), identifier.name);
      if (!variable || variable.defs.length === 0) {
        return VALUE_TYPES.has(identifier.name) ? 'opaqueCast' : undefined;
      }
      for (const def of variable.defs) {
        if (def.type !== 'Type' || seen.has(def.node)) continue;
        // A type parameter is checked where it is asserted to (`isTypeParameter`).
        if (def.node.type === 'TSTypeParameter') continue;
        seen.add(def.node);
        const found = forgedIn(def.node, seen);
        if (found) return found;
      }
      return undefined;
    }

    /** Whether the type subtree `node` can forge the brand: `cast`, `opaqueCast` or undefined. */
    function forgedIn(node, seen) {
      if (!node || typeof node.type !== 'string') return undefined;
      switch (node.type) {
        case 'TSTypeQuery':
        case 'TSInferType':
          return 'opaqueCast';
        case 'TSTypeReference':
        case 'TSInterfaceHeritage':
        case 'TSImportType': {
          if (namesBrand(node)) return 'cast';
          const name = node.type === 'TSTypeReference' ? node.typeName : node.expression;
          const found = name?.type === 'Identifier' ? forgedByName(name, seen) : undefined;
          if (found) return found;
          break;
        }
        default:
      }
      for (const key of sourceCode.visitorKeys[node.type] ?? []) {
        const child = node[key];
        for (const c of Array.isArray(child) ? child : [child]) {
          const found = forgedIn(c, seen);
          if (found) return found;
        }
      }
      return undefined;
    }

    /** Whether the type `node` is `never`, following same-file aliases. */
    function isNever(node, seen) {
      switch (node?.type) {
        case 'TSNeverKeyword':
          return true;
        case 'TSUnionType':
          return node.types.every((t) => isNever(t, seen));
        case 'TSIntersectionType':
          return (
            node.types.some((t) => isNever(t, seen)) ||
            new Set(node.types.map((t) => t.type).filter((t) => PRIMITIVES.has(t))).size > 1
          );
        case 'TSTypeReference': {
          if (node.typeName.type !== 'Identifier') return false;
          const def = findVariable(sourceCode.getScope(node), node.typeName.name)?.defs[0];
          if (def?.node.type !== 'TSTypeAliasDeclaration' || seen.has(def.node)) return false;
          seen.add(def.node);
          return isNever(def.node.typeAnnotation, seen);
        }
        default:
          return false;
      }
    }

    /** Whether the type `node` is a bare type parameter, alone or in a union or intersection. */
    function isTypeParameter(node) {
      if (node.type === 'TSUnionType' || node.type === 'TSIntersectionType') {
        return node.types.some(isTypeParameter);
      }
      if (node.type !== 'TSTypeReference' || node.typeName.type !== 'Identifier') return false;
      const def = findVariable(sourceCode.getScope(node), node.typeName.name)?.defs[0];
      return def?.node.type === 'TSTypeParameter';
    }

    // Asserted types, which `checkCast` reports before `checkPosition` sees them.
    const assertedTypes = new WeakSet();

    function checkCast(node) {
      const type = node.typeAnnotation;
      assertedTypes.add(type);
      let messageId = forgedIn(type, new Set());
      if (isNever(type, new Set())) messageId = 'never';
      else if (isTypeParameter(type) || hasFreeTypeParameter(type)) messageId ??= 'opaqueCast';
      if (messageId) context.report({ node, messageId });
    }

    /** Whether `ref` is exactly the type of a parameter of a function with a body. */
    function typesParameter(ref) {
      if (ref.parent?.type !== 'TSTypeAnnotation') return false;
      let param = ref.parent.parent;
      if (param?.type !== 'Identifier') return false;
      if (param.parent.type === 'AssignmentPattern' && param.parent.left === param) {
        param = param.parent;
      }
      const fn = param.parent;
      // An overloaded method's callers see only its signatures, which
      // TypeScript compares bivariantly with the implementation.
      return RUNTIME_FUNCTIONS.has(fn.type) && fn.params.includes(param) && !isOverloadedMethod(fn);
    }

    function checkNeverAnnotation(annotation) {
      const type = annotation?.typeAnnotation;
      if (type && isNever(type, new Set())) context.report({ node: type, messageId: 'never' });
    }

    function checkPosition(node) {
      if (!namesBrand(node) || typesParameter(node)) return;
      for (let n = node; n?.type.startsWith('TS'); n = n.parent) {
        if (assertedTypes.has(n)) return;
      }
      context.report({ node, messageId: 'position' });
    }

    return {
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,
      TSTypeReference: checkPosition,
      TSImportType: checkPosition,
      TSInterfaceHeritage: checkPosition,
      TSClassImplements: checkPosition,

      // A re-export names the brand under another name, out of the
      // position check's sight in the importing file.
      ExportSpecifier(node) {
        const declaration = node.parent;
        const local = node.local.name ?? node.local.value;
        const forged = declaration.source
          ? importsFrom(declaration, CONNECTION_SOURCE, filename) && local === BRAND
          : isBrandName(local, sourceCode.getScope(node));
        if (forged) context.report({ node, messageId: 'position' });
      },
      ExportAllDeclaration(node) {
        if (importsFrom(node, CONNECTION_SOURCE, filename)) {
          context.report({ node, messageId: 'position' });
        }
      },
      TSImportEqualsDeclaration(node) {
        if (isBrandEntity(node.moduleReference, sourceCode.getScope(node))) {
          context.report({ node, messageId: 'position' });
        }
      },

      TSTypePredicate(node) {
        checkNeverAnnotation(node.typeAnnotation);
      },
      'TSDeclareFunction, TSEmptyBodyFunctionExpression'(node) {
        checkNeverAnnotation(node.returnType);
      },

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
