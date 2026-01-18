// util/time.js — HakMun API (v0.12)
// Deterministic timeouts (fail-fast)

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
    )
  ]);
}

module.exports = { withTimeout };