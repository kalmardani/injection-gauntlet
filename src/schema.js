// A small validator for the subset of JSON Schema this project uses.
// Supported keywords: type, properties, required, additionalProperties, items,
// enum, const, minLength, maxLength, pattern, minimum, maximum, minItems,
// maxItems, anyOf. Anything else in a schema is ignored on purpose, so the
// same schema objects can be handed to model providers as tool parameters.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

/**
 * Validate a value. Returns a list of error strings, empty when valid.
 * Each error names the path, the rule and the offending value class, so the
 * message can be shown to a model or a human and they can fix the input.
 */
export function validate(value, schema, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => validate(value, s, path, []));
    if (!branches.some((b) => b.length === 0)) {
      const best = branches.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(...best);
    }
    return errors;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.some((t) => typeMatches(t, actual))) {
      errors.push(`${path} must be ${types.join(' or ')}, got ${actual}`);
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must have at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must have at most ${schema.maxLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path} must match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must have at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} must have at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
    }
  }

  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) {
        validate(v, props[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not an allowed field`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(v, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }
  return errors;
}

/** Validate and throw a single readable error when invalid. */
export function assertValid(value, schema, label) {
  const errors = validate(value, schema);
  if (errors.length) {
    const err = new Error(`${label} is invalid; ${errors.slice(0, 8).join('; ')}`);
    err.validationErrors = errors;
    throw err;
  }
  return value;
}
