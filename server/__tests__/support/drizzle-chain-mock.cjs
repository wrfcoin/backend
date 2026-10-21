/**
 * Chain-aware Drizzle mock for the legacy server/__tests__ service suites.
 *
 * The production API is a thenable builder (`db.select().from().where()`), but
 * these suites historically configured the chain-start mock with
 * `mockResolvedValueOnce`. A normal Jest mock then returns a Promise too early,
 * so the next builder method is missing. Keep the familiar per-operation
 * configuration while resolving only when the completed builder is awaited.
 */
function createDrizzleChainMock(jest) {
  const operationNames = ['select', 'insert', 'update', 'delete'];
  const chainMethodNames = [
    'from',
    'where',
    'limit',
    'orderBy',
    'values',
    'returning',
    'set',
  ];
  const queued = Object.fromEntries(operationNames.map(name => [name, []]));
  const defaults = Object.fromEntries(
    operationNames.map(name => [name, () => Promise.resolve([])])
  );

  const db = {};
  for (const methodName of chainMethodNames) {
    db[methodName] = jest.fn(function chainMethod() {
      return this;
    });
  }

  function nextResult(operationName) {
    const factory = queued[operationName].shift() ?? defaults[operationName];
    return factory();
  }

  function buildQuery(operationName) {
    const query = {
      then(resolve, reject) {
        return nextResult(operationName).then(resolve, reject);
      },
    };
    for (const methodName of chainMethodNames) {
      query[methodName] = db[methodName];
    }
    return query;
  }

  function operationMock(operationName) {
    const fn = jest.fn(() => buildQuery(operationName));
    fn.mockResolvedValueOnce = value => {
      queued[operationName].push(() => Promise.resolve(value));
      return fn;
    };
    fn.mockRejectedValueOnce = error => {
      queued[operationName].push(() => Promise.reject(error));
      return fn;
    };
    fn.mockResolvedValue = value => {
      defaults[operationName] = () => Promise.resolve(value);
      return fn;
    };
    fn.mockRejectedValue = error => {
      defaults[operationName] = () => Promise.reject(error);
      return fn;
    };
    // Existing suites call this during reset. The operation must continue to
    // return its builder rather than the Drizzle object.
    fn.mockReturnThis = () => fn;
    return fn;
  }

  for (const operationName of operationNames) {
    db[operationName] = operationMock(operationName);
  }

  function resetResults() {
    for (const operationName of operationNames) {
      queued[operationName].length = 0;
      defaults[operationName] = () => Promise.resolve([]);
    }
  }

  return { db, resetResults };
}

module.exports = { createDrizzleChainMock };
