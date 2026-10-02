'use strict';
// Minimal JSON Schema validator covering the keywords used in templates/schemas:
// type, enum, const, properties, required, additionalProperties, items, minItems,
// maxItems, minimum, maximum, exclusiveMinimum, minLength, maxLength, pattern,
// anyOf, oneOf, $ref (local #/$defs/...). Unknown keywords are ignored.

const path = require('path');
const { readJson } = require('./fsx');

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function isType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => (node ? node[key] : undefined), root);
}

function walk(schema, value, at, root, errors) {
  if (schema === undefined || schema === true) return;
  if (schema === false) {
    errors.push(`${at}: not allowed`);
    return;
  }
  if (schema.$ref) {
    walk(resolveRef(root, schema.$ref), value, at, root, errors);
    return;
  }
  if (schema.anyOf && !schema.anyOf.some((s) => check(s, value, root).length === 0)) {
    errors.push(`${at}: does not match any allowed form`);
  }
  if (schema.oneOf && schema.oneOf.filter((s) => check(s, value, root).length === 0).length !== 1) {
    errors.push(`${at}: must match exactly one allowed form`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}: must be > ${schema.exclusiveMinimum}`);
    if (!Number.isFinite(value)) errors.push(`${at}: must be a finite number`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => walk(schema.items, item, `${at}[${i}]`, root, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}: missing required field "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key] !== undefined) walk(props[key], v, `${at}.${key}`, root, errors);
      else if (schema.additionalProperties !== undefined) walk(schema.additionalProperties, v, `${at}.${key}`, root, errors);
    }
  }
}

function check(schema, value, root = schema) {
  const errors = [];
  walk(schema, value, '$', root, errors);
  return errors;
}

function validate(schema, value) {
  const errors = check(schema, value, schema);
  return { valid: errors.length === 0, errors };
}

const cache = new Map();
function loadSchema(ws, name) {
  const abs = path.join(ws.root, 'templates', 'schemas', `${name}.schema.json`);
  if (!cache.has(abs)) cache.set(abs, readJson(abs));
  return cache.get(abs);
}

module.exports = { validate, loadSchema, typeOf };
