/**
 * Request input as text. Query strings and JSON bodies can carry objects and
 * arrays where a route expects a string (?user[toString]=x, {"author":{}}), and
 * String() of such a value throws or gives "[object Object]". Anything that is not
 * a string, a number or a boolean reads as empty, so the route's own validation
 * answers 400.
 */
function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

module.exports = { asText };
