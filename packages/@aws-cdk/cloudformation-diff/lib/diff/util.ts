import { loadAwsServiceSpecSync } from '@aws-cdk/aws-service-spec';
import type { Resource, SpecDatabase } from '@aws-cdk/service-spec-types';

/**
 * Compares two objects for equality, deeply. The function handles arguments that are
 * +null+, +undefined+, arrays and objects. For objects, the function will not take the
 * object prototype into account for the purpose of the comparison, only the values of
 * properties reported by +Object.keys+.
 *
 * If both operands can be parsed to equivalent numbers, will return true.
 * This makes diff consistent with CloudFormation, where a numeric 10 and a literal "10"
 * are considered equivalent.
 *
 * @param lvalue - the left operand of the equality comparison.
 * @param rvalue - the right operand of the equality comparison.
 *
 * @returns +true+ if both +lvalue+ and +rvalue+ are equivalent to each other.
 */
export function deepEqual(lvalue: any, rvalue: any): boolean {
  if (lvalue === rvalue) {
    return true;
  }
  // CloudFormation allows passing strings into boolean-typed fields
  if (((typeof lvalue === 'string' && typeof rvalue === 'boolean') ||
      (typeof lvalue === 'boolean' && typeof rvalue === 'string')) &&
      lvalue.toString() === rvalue.toString()) {
    return true;
  }
  // allows a numeric 10 and a literal "10" to be equivalent;
  // this is consistent with CloudFormation.
  if ((typeof lvalue === 'string' || typeof rvalue === 'string') &&
      safeParseFloat(lvalue) === safeParseFloat(rvalue)) {
    return true;
  }
  if (typeof lvalue !== typeof rvalue) {
    return false;
  }
  if (Array.isArray(lvalue) !== Array.isArray(rvalue)) {
    return false;
  }
  if (Array.isArray(lvalue) /* && Array.isArray(rvalue) */) {
    if (lvalue.length !== rvalue.length) {
      return false;
    }
    for (let i = 0 ; i < lvalue.length ; i++) {
      if (!deepEqual(lvalue[i], rvalue[i])) {
        return false;
      }
    }
    return true;
  }
  if (typeof lvalue === 'object' /* && typeof rvalue === 'object' */) {
    if (lvalue === null || rvalue === null) {
      // If both were null, they'd have been ===
      return false;
    }
    const keys = Object.keys(lvalue);
    if (keys.length !== Object.keys(rvalue).length) {
      return false;
    }
    for (const key of keys) {
      if (!rvalue.hasOwnProperty(key)) {
        return false;
      }
      if (key === 'DependsOn') {
        if (!dependsOnEqual(lvalue[key], rvalue[key])) {
          return false;
        }
        // check differences other than `DependsOn`
        continue;
      }
      if (!deepEqual(lvalue[key], rvalue[key])) {
        return false;
      }
    }
    return true;
  }
  // Neither object, nor array: I deduce this is primitive type
  // Primitive type and not ===, so I deduce not deepEqual
  return false;
}

/**
 * Compares two arguments to DependsOn for equality.
 *
 * @param lvalue - the left operand of the equality comparison.
 * @param rvalue - the right operand of the equality comparison.
 *
 * @returns +true+ if both +lvalue+ and +rvalue+ are equivalent to each other.
 */
function dependsOnEqual(lvalue: any, rvalue: any): boolean {
  // allows ['Value'] and 'Value' to be equal
  if (Array.isArray(lvalue) !== Array.isArray(rvalue)) {
    const array = Array.isArray(lvalue) ? lvalue : rvalue;
    const nonArray = Array.isArray(lvalue) ? rvalue : lvalue;

    if (array.length === 1 && deepEqual(array[0], nonArray)) {
      return true;
    }
    return false;
  }

  // allows arrays passed to DependsOn to be equivalent irrespective of element order
  if (Array.isArray(lvalue) && Array.isArray(rvalue)) {
    if (lvalue.length !== rvalue.length) {
      return false;
    }
    for (let i = 0 ; i < lvalue.length ; i++) {
      for (let j = 0 ; j < lvalue.length ; j++) {
        if ((!deepEqual(lvalue[i], rvalue[j])) && (j === lvalue.length - 1)) {
          return false;
        }
        break;
      }
    }
    return true;
  }

  return false;
}

/**
 * Produce the differences between two maps, as a map, using a specified diff function.
 *
 * @param oldValue  - the old map.
 * @param newValue  - the new map.
 * @param elementDiff - the diff function.
 *
 * @returns a map representing the differences between +oldValue+ and +newValue+.
 */
export function diffKeyedEntities<T>(
  oldValue: { [key: string]: any } | undefined,
  newValue: { [key: string]: any } | undefined,
  elementDiff: (oldElement: any, newElement: any, key: string) => T): { [name: string]: T } {
  const result: { [name: string]: T } = {};
  for (const logicalId of unionOf(Object.keys(oldValue || {}), Object.keys(newValue || {}))) {
    const oldElement = oldValue && oldValue[logicalId];
    const newElement = newValue && newValue[logicalId];

    if (oldElement === undefined && newElement === undefined) {
      // Shouldn't happen in reality, but may happen in tests. Skip.
      continue;
    }

    result[logicalId] = elementDiff(oldElement, newElement, logicalId);
  }
  return result;
}

/**
 * Computes the union of two sets of strings.
 *
 * @param lv - the left set of strings.
 * @param rv - the right set of strings.
 *
 * @returns a new array containing all elemebts from +lv+ and +rv+, with no duplicates.
 */
export function unionOf(lv: string[] | Set<string>, rv: string[] | Set<string>): string[] {
  const result = new Set(lv);
  for (const v of rv) {
    result.add(v);
  }
  return new Array(...result);
}

/**
 * GetStackTemplate flattens any codepoint greater than "\u7f" to "?". This is
 * true even for codepoints in the supplemental planes which are represented
 * in JS as surrogate pairs, all the way up to "\u{10ffff}".
 *
 * This function implements the same mangling in order to provide diagnostic
 * information in `cdk diff`.
 */
export function mangleLikeCloudFormation(payload: string) {
  return payload.replace(/[\u{80}-\u{10ffff}]/gu, '?');
}

/**
 * A parseFloat implementation that does the right thing for
 * strings like '0.0.0'
 * (for which JavaScript's parseFloat() returns 0).
 * We return NaN for all of these strings that do not represent numbers,
 * and so comparing them fails,
 * and doesn't short-circuit the diff logic.
 */
function safeParseFloat(str: string): number {
  return Number(str);
}

/**
 * Lazily load the service spec database and cache the loaded db
 */
let DATABASE: SpecDatabase | undefined;
function database(): SpecDatabase {
  if (!DATABASE) {
    DATABASE = loadAwsServiceSpecSync();
  }
  return DATABASE;
}

/**
 * Load a Resource model from the Service Spec Database
 *
 * The database is loaded lazily and cached across multiple calls to `loadResourceModel`.
 */
export function loadResourceModel(type: string): Resource | undefined {
  return database().lookup('resource', 'cloudFormationType', 'equals', type)[0];
}
