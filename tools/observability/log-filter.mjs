/**
 * A small evaluator for the subset of CloudWatch Logs JSON filter patterns that monitoring.json uses,
 * so a test can check a pattern against a real log line instead of trusting it by eye.
 *
 * Supported: `{ $.field = "text" }`, `{ $.field >= 500 }`, the operators = != < <= > >=, and
 * conditions joined with `&&` and `||` (`&&` binds tighter). Not supported: parentheses, wildcards,
 * nested arrays. A field that is missing from the line never matches, as in CloudWatch.
 */

const CONDITION = /^\$\.([A-Za-z0-9_.]+)\s*(=|!=|<=|>=|<|>)\s*("([^"]*)"|-?\d+(?:\.\d+)?)$/;

function parseCondition(text) {
  const match = CONDITION.exec(text.trim());
  if (match === null) throw new Error(`Unsupported filter condition: ${text}`);
  const [, path, operator, literal, quoted] = match;
  return { path, operator, value: quoted === undefined ? Number(literal) : quoted };
}

/** Parses `{ ... }` into a list of OR-ed groups of AND-ed conditions. */
export function parseFilter(pattern) {
  const trimmed = pattern.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error(`A JSON filter pattern must be wrapped in braces: ${pattern}`);
  }
  const body = trimmed.slice(1, -1);
  if (/[()]/.test(body.replace(/"[^"]*"/g, ''))) {
    throw new Error(`Parentheses are not supported: ${pattern}`);
  }
  return body.split('||').map((group) => group.split('&&').map(parseCondition));
}

function lookup(record, path) {
  let current = record;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function holds({ path, operator, value }, record) {
  const actual = lookup(record, path);
  if (actual === undefined || actual === null) return false;
  if (typeof value === 'number') {
    if (typeof actual !== 'number') return false;
    return {
      '=': actual === value,
      '!=': actual !== value,
      '<': actual < value,
      '<=': actual <= value,
      '>': actual > value,
      '>=': actual >= value,
    }[operator];
  }
  if (typeof actual !== 'string') return false;
  if (operator === '=') return actual === value;
  if (operator === '!=') return actual !== value;
  throw new Error(`Operator ${operator} is only for numbers`);
}

/** Does this log record (an object, or a JSON line) match the pattern? */
export function matches(pattern, record) {
  const parsed = typeof record === 'string' ? JSON.parse(record) : record;
  return parseFilter(pattern).some((group) => group.every((condition) => holds(condition, parsed)));
}

/** The numeric value a metric filter's `value` would extract from a record: `"1"` or `"$.field"`. */
export function extractValue(valueExpression, record) {
  const parsed = typeof record === 'string' ? JSON.parse(record) : record;
  if (/^-?\d+(\.\d+)?$/.test(valueExpression)) return Number(valueExpression);
  const field = /^\$\.([A-Za-z0-9_.]+)$/.exec(valueExpression);
  if (field === null) throw new Error(`Unsupported metric value: ${valueExpression}`);
  const found = lookup(parsed, field[1]);
  return typeof found === 'number' ? found : undefined;
}
