// Scores one engine's replay decisions against the corpus labels.
// Positive class: "deny" for commands, "advice" for failures. Precision = TP / (TP + FP),
// recall = TP / (TP + FN), computed over labeled rows including known gaps, so the numbers
// describe what the engine does today. Rows marked status "known-gap" may fail without failing
// the run; a known gap that passes is reported so its label can be removed.

function score(rows, results, positive, decisionOf, textOf) {
  const m = {
    labeled: 0,
    unlabeled: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    hintMisses: 0,
    gapsOpen: 0,
    gapsClosed: 0,
    positiveAlthoughSucceeded: 0,
    failures: [],
    closed: [],
  };
  for (const r of rows) {
    const res = results[r.id];
    if (!res) {
      m.failures.push({ id: r.id, why: "no result recorded" });
      continue;
    }
    const got = decisionOf(res);
    if (got === positive && r.succeeded === true) m.positiveAlthoughSucceeded++;
    if (r.expect == null) {
      m.unlabeled++;
      continue;
    }
    m.labeled++;
    const want = r.expect;
    if (want === positive && got === positive) m.tp++;
    else if (want === positive) m.fn++;
    else if (got === positive) m.fp++;
    else m.tn++;
    const hintOk = !r.hint || got !== positive || (textOf(res) ?? "").toLowerCase().includes(String(r.hint).toLowerCase());
    if (want === got && !hintOk) m.hintMisses++;
    const ok = want === got && hintOk;
    if (r.status === "known-gap") {
      if (ok) {
        m.gapsClosed++;
        m.closed.push(r.id);
      } else m.gapsOpen++;
    } else if (!ok) {
      const why = want === got ? `hint "${r.hint}" missing in: ${(textOf(res) ?? "").slice(0, 140)}` : `expected ${want}, got ${got}: ${(textOf(res) ?? "").slice(0, 140)}`;
      m.failures.push({ id: r.id, why });
    }
  }
  m.precision = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 1;
  m.recall = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : 1;
  return m;
}

// results: id -> { decision: "allow" | "deny", reason: string }
export function scoreCommands(rows, results) {
  return score(rows, results, "deny", (r) => r.decision, (r) => r.reason);
}

// results: id -> { advice: string | null }
export function scoreFailures(rows, results) {
  return score(rows, results, "advice", (r) => (r.advice ? "advice" : "silent"), (r) => r.advice);
}

export function toBaseline(m) {
  return {
    labeled: m.labeled,
    tp: m.tp,
    fp: m.fp,
    fn: m.fn,
    tn: m.tn,
    precision: round(m.precision),
    recall: round(m.recall),
    gapsOpen: m.gapsOpen,
  };
}

// Returns the list of regressions against a committed baseline (empty when none).
export function compareToBaseline(name, m, baseline, tolerance = 0.0005) {
  const out = [];
  if (!baseline) return out;
  if (m.precision + tolerance < baseline.precision) out.push(`${name}: precision ${round(m.precision)} is below the baseline ${baseline.precision}`);
  if (m.recall + tolerance < baseline.recall) out.push(`${name}: recall ${round(m.recall)} is below the baseline ${baseline.recall}`);
  return out;
}

export function summarize(name, m) {
  return [
    `${name}: ${m.labeled} labeled rows (${m.unlabeled} unlabeled), tp=${m.tp} fp=${m.fp} fn=${m.fn} tn=${m.tn}`,
    `  precision=${round(m.precision)} recall=${round(m.recall)} hint-misses=${m.hintMisses} known-gaps open=${m.gapsOpen} closed=${m.gapsClosed} positive-although-succeeded=${m.positiveAlthoughSucceeded}`,
    ...(m.closed.length ? [`  known gaps now passing (remove their status): ${m.closed.join(", ")}`] : []),
    ...m.failures.map((f) => `  FAIL ${f.id}: ${f.why}`),
  ].join("\n");
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}
